import json
import os
import sqlite3
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from urllib.parse import quote

import pytest

from spooly.app import create_app
from spooly.services.database import AppDatabase, MIGRATIONS
from spooly.services.favorites import FavoriteService
from spooly.services.library import LibraryService
from spooly.services.reactions import FAVORITES_IMPORT, MediaReactionStore


@pytest.fixture
def app(tmp_path):
    media = tmp_path / 'media'
    media.mkdir()
    for name in ('照片 & hash#%.jpg', 'clip.mp4', 'song.mp3'):
        (media / name).write_bytes(b'media')
    return create_app({'TESTING': True, 'MEDIA_ROOT': media})


def reaction_url(uri, kind):
    return f'/api/media/{quote(uri, safe="")}/{kind}'


def test_version_12_upgrade_imports_once_and_keeps_original_data(tmp_path):
    media = tmp_path / 'media'
    media.mkdir()
    (media / 'photo.jpg').write_bytes(b'image')
    data = Path(os.environ['SPOOLY_INSTANCE'])
    data.mkdir()
    legacy = data / 'favorites.json'
    legacy.write_text(json.dumps([
        'photo.jpg', './photo.jpg', '@default/photo.jpg',
        '@music/song.mp3', '@offline/missing.mp4',
    ]), encoding='utf-8')
    original = legacy.read_bytes()
    database = AppDatabase(data / 'spooly.sqlite3')
    with database.connect() as conn:
        conn.execute('CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, name TEXT, applied_at TEXT)')
        for migration in MIGRATIONS:
            if migration.version <= 12:
                migration.up(conn)
                conn.execute('INSERT INTO schema_migrations VALUES (?, ?, ?)',
                             (migration.version, migration.name, 'old'))
        conn.execute("INSERT INTO playback_positions VALUES ('@default/photo.jpg', 30, 300, 'old')")
    config = {'TESTING': True, 'MEDIA_ROOT': media, 'APP_DATABASE': database}
    app = create_app(config)
    reactions = app.extensions['media_reactions']
    assert reactions.favorites() == {
        '@default/photo.jpg', '@music/song.mp3', '@offline/missing.mp4',
    }
    imported = reactions.get('photo.jpg')
    assert imported['is_favorited'] is True and imported['favorited_at']
    assert imported['is_liked'] is False and imported['liked_at'] is None
    assert legacy.read_bytes() == original
    client = app.test_client()
    assert client.post('/api/favorite/photo.jpg').json['favorite'] is False
    assert client.post(reaction_url('photo.jpg', 'like'), json={'state': True}).json['data']['is_liked']

    # A later stale/corrupt archive must never revive a removed favorite.
    legacy.write_text('[broken', encoding='utf-8')
    again = create_app(config).extensions['media_reactions']
    assert again.get('photo.jpg')['is_favorited'] is False
    assert again.get('photo.jpg')['is_liked'] is True
    assert again.get('@music/song.mp3')['favorited_at'] == imported['favorited_at']
    with database.connect() as conn:
        assert conn.execute('SELECT MAX(version) FROM schema_migrations').fetchone()[0] == 14
        assert conn.execute('SELECT COUNT(*) FROM data_migrations WHERE name = ?', (FAVORITES_IMPORT,)).fetchone()[0] == 1
        assert conn.execute('SELECT position FROM playback_positions').fetchone()[0] == 30


@pytest.mark.parametrize('payload', ['[broken', '{}', '[null]', '["photo.jpg", 1]', '[""]'])
def test_invalid_legacy_file_is_preserved_without_marking_import(tmp_path, payload):
    media = tmp_path / 'media'
    media.mkdir()
    data = Path(os.environ['SPOOLY_INSTANCE'])
    data.mkdir()
    legacy = data / 'favorites.json'
    legacy.write_text(payload, encoding='utf-8')
    config = {'TESTING': True, 'MEDIA_ROOT': media}
    with pytest.raises(ValueError):
        create_app(config)
    assert legacy.read_text(encoding='utf-8') == payload
    database = AppDatabase(data / 'spooly.sqlite3')
    with database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM media_reactions').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM data_migrations').fetchone()[0] == 0
    legacy.write_text('["photo.jpg"]', encoding='utf-8')
    assert create_app(config).extensions['media_reactions'].get('photo.jpg')['is_favorited'] is True


def test_import_rolls_back_rows_and_marker_together(tmp_path):
    database = AppDatabase(tmp_path / 'state.sqlite3')
    database.migrate()
    legacy = tmp_path / 'favorites.json'
    legacy.write_text('["a.jpg", "b.jpg"]', encoding='utf-8')
    reactions = MediaReactionStore(database, LibraryService(tmp_path))
    with database.connect() as conn:
        conn.execute("""
            CREATE TRIGGER fail_import BEFORE INSERT ON media_reactions
            WHEN NEW.uri = '@default/b.jpg'
            BEGIN SELECT RAISE(ABORT, 'interrupted import'); END
        """)
    with pytest.raises(sqlite3.IntegrityError, match='interrupted import'):
        reactions.import_favorites(legacy)
    with database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM media_reactions').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM data_migrations').fetchone()[0] == 0
        conn.execute('DROP TRIGGER fail_import')
    assert reactions.import_favorites(legacy) == 2
    assert reactions.import_favorites(legacy) == 0
    assert legacy.read_text(encoding='utf-8') == '["a.jpg", "b.jpg"]'


def test_marker_write_failure_rolls_back_import_and_can_retry(tmp_path):
    database = AppDatabase(tmp_path / 'state.sqlite3')
    database.migrate()
    legacy = tmp_path / 'favorites.json'
    legacy.write_text('["photo.jpg"]', encoding='utf-8')
    reactions = MediaReactionStore(database, LibraryService(tmp_path))
    with database.connect() as conn:
        conn.execute("""
            CREATE TRIGGER fail_import_marker BEFORE INSERT ON data_migrations
            BEGIN SELECT RAISE(ABORT, 'marker unavailable'); END
        """)
    with pytest.raises(sqlite3.IntegrityError, match='marker unavailable'):
        reactions.import_favorites(legacy)
    with database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM media_reactions').fetchone()[0] == 0
        assert conn.execute('SELECT COUNT(*) FROM data_migrations').fetchone()[0] == 0
        conn.execute('DROP TRIGGER fail_import_marker')
    assert reactions.import_favorites(legacy) == 1


def test_concurrent_imports_commit_once_and_preserve_existing_sqlite_state(tmp_path):
    database = AppDatabase(tmp_path / 'state.sqlite3')
    database.migrate()
    legacy = tmp_path / 'favorites.json'
    legacy.write_text('["photo.jpg", "existing.jpg"]', encoding='utf-8')
    library = LibraryService(tmp_path)
    reactions = MediaReactionStore(database, library)
    before = reactions.set_like('existing.jpg', True)

    def run_import(_index):
        return MediaReactionStore(database, library).import_favorites(legacy)

    with ThreadPoolExecutor(max_workers=4) as pool:
        assert sorted(pool.map(run_import, range(4))) == [0, 0, 0, 1]
    assert reactions.get('existing.jpg') == before
    imported = reactions.get('photo.jpg')
    assert imported['is_favorited'] is True and imported['is_liked'] is False
    assert reactions.import_favorites(legacy) == 0
    assert reactions.get('photo.jpg') == imported
    with database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM data_migrations').fetchone()[0] == 1


def test_like_favorite_and_legacy_api_share_independent_persistent_state(app):
    client = app.test_client()
    uri = '@default/照片 & hash#%.jpg'
    like_url = reaction_url(uri, 'like')
    favorite_url = reaction_url(uri, 'favorite')
    liked = client.post(like_url).json['data']
    assert liked['id'] == liked['uri'] == uri
    assert liked['is_liked'] is True and liked['is_favorited'] is False
    assert liked['liked_at'] and liked['favorited_at'] is None
    repeated = client.post(like_url, json={'state': True}).json['data']
    assert repeated == liked
    both = client.post(favorite_url, json={'state': True}).json['data']
    assert both['is_liked'] is True and both['is_favorited'] is True
    assert both['liked_at'] == liked['liked_at']
    legacy_url = '/api/favorite/' + quote(uri, safe='')
    assert client.get(legacy_url).json == {'favorite': True}
    assert client.post(legacy_url).json['favorite'] is False
    reactions = app.extensions['media_reactions']
    assert reactions.get(uri)['is_liked'] is True
    cleared = client.post(like_url, json={'state': False}).json['data']
    assert cleared['is_liked'] is False and cleared['liked_at'] is None
    client.post(favorite_url, json={'state': True})
    restarted = create_app({'TESTING': True, 'MEDIA_ROOT': app.config['MEDIA_ROOT']})
    saved = restarted.extensions['media_reactions'].get(uri)
    assert saved['is_favorited'] is True and saved['is_liked'] is False
    assert saved['favorited_at']


def test_atomic_reactions_preserve_both_columns_and_toggle_parity(app):
    uri = '@default/clip.mp4'

    def set_state(kind):
        with app.test_client() as client:
            response = client.post(reaction_url(uri, kind), json={'state': True})
            assert response.status_code == 200

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(set_state, ['like', 'favorite'] * 12))
    before = app.extensions['media_reactions'].get(uri)
    assert before['is_liked'] is True and before['is_favorited'] is True

    def toggle(_index):
        with app.test_client() as client:
            assert client.post(reaction_url(uri, 'like')).status_code == 200

    with ThreadPoolExecutor(max_workers=8) as pool:
        list(pool.map(toggle, range(15)))
    after = app.extensions['media_reactions'].get(uri)
    assert after['is_liked'] is False
    assert after['is_favorited'] is True
    assert after['favorited_at'] == before['favorited_at']


@pytest.mark.parametrize('variable_limit', [500, 37])
def test_get_many_batches_canonical_states_on_one_read_only_connection(tmp_path, monkeypatch, variable_limit):
    if not hasattr(sqlite3.Connection, 'setlimit'):
        pytest.skip('SQLite runtime limits require Python 3.11 or newer.')
    database = AppDatabase(tmp_path / 'state.sqlite3')
    database.migrate()
    reactions = MediaReactionStore(database, LibraryService(tmp_path))
    liked = reactions.set_like('photo-0.jpg', True)
    favorited = reactions.set_favorite('photo-501.jpg', True)
    connect = database.connect
    with connect() as conn:
        before = [dict(row) for row in conn.execute('SELECT * FROM media_reactions ORDER BY uri')]
    connections, statements = [], []

    def limited_connect():
        conn = connect()
        conn.setlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER, variable_limit)
        conn.set_trace_callback(statements.append)
        connections.append(conn)
        return conn

    monkeypatch.setattr(database, 'connect', limited_connect)
    names = [f'photo-{index}.jpg' for index in range(1205)]
    states = reactions.get_many([*names, './photo-0.jpg', '@default/photo-501.jpg'])
    assert len(connections) == 1
    selects = [statement for statement in statements if statement.startswith('SELECT')]
    assert len(selects) == (1205 + variable_limit - 1) // variable_limit
    assert len(states) == 1205
    assert states['@default/photo-0.jpg'] == liked
    assert states['@default/photo-501.jpg'] == favorited
    assert states['@default/photo-1204.jpg'] == {
        'uri': '@default/photo-1204.jpg', 'is_liked': False, 'liked_at': None,
        'is_favorited': False, 'favorited_at': None,
    }
    assert reactions.get_many([]) == {}
    assert len(connections) == 1
    with connect() as conn:
        assert [dict(row) for row in conn.execute('SELECT * FROM media_reactions ORDER BY uri')] == before


def test_bulk_favorite_compatibility_preserves_likes_and_existing_times(app):
    reactions = app.extensions['media_reactions']
    first = reactions.set_favorite('clip.mp4', True)
    reactions.set_like('clip.mp4', True)
    facade = FavoriteService(Path(os.environ['SPOOLY_INSTANCE']) / 'favorites.json',
                             reactions.library, database=reactions.database)
    facade.save({'clip.mp4', 'song.mp3'})
    assert facade.load() == {'@default/clip.mp4', '@default/song.mp3'}
    assert reactions.get('clip.mp4')['favorited_at'] == first['favorited_at']
    facade.save({'song.mp3'})
    assert reactions.get('clip.mp4')['is_liked'] is True
    assert reactions.get('clip.mp4')['is_favorited'] is False


@pytest.mark.parametrize('payload', [None, [], True, {'state': 'true'}, {'state': 1}, {'state': None}, {'liked': True}])
def test_invalid_state_bodies_do_not_toggle(app, payload):
    response = app.test_client().post(reaction_url('clip.mp4', 'like'),
                                      data=json.dumps(payload), content_type='application/json')
    assert response.status_code == 400
    assert app.extensions['media_reactions'].get('clip.mp4')['is_liked'] is False


def test_malformed_json_does_not_toggle(app):
    response = app.test_client().post(reaction_url('clip.mp4', 'favorite'),
                                      data='{broken', content_type='application/json')
    assert response.status_code == 400
    assert app.extensions['media_reactions'].favorites() == set()


@pytest.mark.parametrize('uri,status', [
    ('missing.jpg', 404), ('@unknown/clip.mp4', 404),
    ('../outside.jpg', 400), ('@default/../outside.jpg', 400),
    ('@default/C:/outside.jpg', 400), ('@default/null\x00.jpg', 400),
])
def test_new_reaction_routes_validate_media_paths(app, uri, status):
    response = app.test_client().post(reaction_url(uri, 'like'))
    assert response.status_code == status
    with app.extensions['media_reactions'].database.connect() as conn:
        assert conn.execute('SELECT COUNT(*) FROM media_reactions').fetchone()[0] == 0


def test_index_rebuild_and_exclusions_do_not_destroy_user_state(app):
    client = app.test_client()
    client.post(reaction_url('clip.mp4', 'like'))
    client.post(reaction_url('clip.mp4', 'favorite'))
    root = app.config['MEDIA_ROOT']
    config = {'TESTING': True, 'MEDIA_ROOT': root}
    excluded = create_app({**config, 'MEDIA_EXCLUDE': ['clip.mp4']})
    hidden = excluded.test_client()
    assert hidden.get('/api/feed?filter=liked').json['data']['items'] == []
    assert hidden.post(reaction_url('clip.mp4', 'like')).status_code == 404
    state = excluded.extensions['media_reactions'].get('clip.mp4')
    assert state['is_liked'] is True and state['is_favorited'] is True
    restored = create_app(config).test_client().get('/api/feed?filter=liked').json['data']['items']
    assert [item['name'] for item in restored] == ['@default/clip.mp4']
    assert restored[0]['is_liked'] is True and restored[0]['is_favorited'] is True


def test_new_endpoints_follow_authentication_and_csrf(tmp_path, monkeypatch):
    monkeypatch.setenv('SPOOLY_AUTH_PASSWORD', 'phase-two-test-password')
    (tmp_path / 'clip.mp4').write_bytes(b'video')
    app = create_app({'TESTING': True, 'AUTH_ENABLED': True, 'MEDIA_ROOT': tmp_path})
    client = app.test_client()
    url = reaction_url('clip.mp4', 'like')
    for path in ('/api/folders', '/api/feed'):
        assert client.get(path).status_code == 401
    assert client.post(url).status_code == 401
    client.get('/login')
    with client.session_transaction() as session:
        token = session['_csrf_token']
    assert client.post('/login', data={
        'password': 'phase-two-test-password', '_csrf_token': token,
    }).status_code == 302
    with client.session_transaction() as session:
        token = session['_csrf_token']
    assert client.post(url).status_code == 403
    assert client.post(url, json={'state': True}, headers={'X-CSRF-Token': token}).status_code == 200
    assert client.get('/api/feed?filter=liked').json['data']['total'] == 1
