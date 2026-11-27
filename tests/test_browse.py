from dataclasses import replace
from pathlib import Path
from types import SimpleNamespace

from flask import Flask
import pytest

from spooly.services.database import AppDatabase
from spooly.services.library import LibraryService, MediaSource
from spooly.services.library_index import LibraryIndexer, MediaIndexStore
from spooly.web.browse import register_browse_routes


@pytest.fixture
def browse(tmp_path):
    roots = {name: tmp_path / name for name in ('default', 'nas', 'empty')}
    for root in roots.values():
        root.mkdir()
    files = {
        'default': (
            'root.mp4', 'a/01.jpg', 'a/02.mp4', 'a/sub/03.jpg',
            'ab/other.jpg', 'Travel/2024/day/shot.jpg', 'audio/song.mp3',
        ),
        'nas': ('a/remote.jpg',),
    }
    for source_id, relatives in files.items():
        for relative in relatives:
            path = roots[source_id] / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b'media')
    (roots['default'] / 'empty-folder').mkdir()
    library = LibraryService(media_sources=[
        MediaSource('default', 'Local', roots['default']),
        MediaSource('nas', 'NAS', roots['nas']),
        MediaSource('empty', 'Empty', roots['empty']),
    ])
    database = AppDatabase(tmp_path / 'state' / 'browse.sqlite3')
    database.migrate()
    media_index = MediaIndexStore(database)
    indexer = LibraryIndexer(library, media_index)
    indexer.sync()
    app = Flask(__name__)
    app.config['TESTING'] = True
    register_browse_routes(
        app, library_service=library, media_index=media_index,
        reactions=None, activity_store=None,
    )
    return SimpleNamespace(
        client=app.test_client(), roots=roots, library=library,
        database=database, media_index=media_index, indexer=indexer,
    )


def _data(browse, endpoint, **query):
    response = browse.client.get(endpoint, query_string=query)
    assert response.status_code == 200, response.get_json()
    payload = response.get_json()
    assert payload['success'] is True
    return payload['data']


def _names(page):
    return [item['name'] for item in page['items']]


def _reaction(browse, uri, *, liked_at=None, favorited_at=None):
    with browse.database.connect() as conn:
        conn.execute(
            """
            INSERT INTO media_reactions(
                uri, is_liked, liked_at, is_favorited, favorited_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(uri) DO UPDATE SET
                is_liked = excluded.is_liked, liked_at = excluded.liked_at,
                is_favorited = excluded.is_favorited,
                favorited_at = excluded.favorited_at, updated_at = excluded.updated_at
            """,
            (uri, int(liked_at is not None), liked_at,
             int(favorited_at is not None), favorited_at, '2026-11-26T00:00:00Z'),
        )


def _index_file(browse, relative, *, source_id='default'):
    # Direct upsert also exercises literal POSIX backslashes: the browsing API
    # must not turn a directory name into a LIKE pattern or another directory.
    path = browse.roots[source_id] / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(b'media')
    browse.media_index.upsert([{
        'uri': f'@{source_id}/{relative}',
        'source_id': source_id,
        'rel_path': relative,
        'filename': path.name,
        'parent_path': relative.rpartition('/')[0] or '.',
        'media_type': 'video' if path.suffix == '.mp4' else 'image',
        'extension': path.suffix,
        'size_bytes': 5,
        'mtime': 1_700_000_000,
    }])


def test_folder_roots_counts_covers_and_lazy_ancestors(browse):
    page = _data(browse, '/api/folders')
    assert page['parent'] is None and page['current'] is None
    assert [node['uri'] for node in page['items']] == ['@default/', '@empty/', '@nas/']
    roots = {node['source_id']: node for node in page['items']}
    local = roots['default']
    assert local['path'] == '' and local['parent_uri'] is None
    assert local['name'] == 'Local'
    assert (local['media_count'], local['video_count'], local['image_count']) == (6, 2, 4)
    assert local['direct_media_count'] == 1
    assert local['cover_uri'] == '@default/Travel/2024/day/shot.jpg'
    assert local['thumb_url'].startswith('/thumb?uri=')
    assert local['has_children'] is True
    assert roots['empty']['media_count'] == 0
    assert roots['empty']['cover_uri'] == roots['empty']['thumb_url'] == ''
    assert roots['empty']['has_children'] is False

    children = _data(browse, '/api/folders', folder='@default/')
    assert children['parent'] == '@default/'
    assert children['current'] == local
    assert [node['path'] for node in children['items']] == ['Travel', 'a', 'ab']
    a = next(node for node in children['items'] if node['path'] == 'a')
    assert a['parent_uri'] == '@default/'
    assert (a['media_count'], a['direct_media_count']) == (3, 2)
    assert (a['video_count'], a['image_count']) == (1, 2)
    assert a['cover_uri'] == '@default/a/01.jpg'
    deep = _data(browse, '/api/folders', folder='@default/Travel')
    assert [node['path'] for node in deep['items']] == ['Travel/2024']
    assert deep['items'][0]['has_children'] is True
    assert deep['current']['direct_media_count'] == 0


def test_folder_pagination_and_empty_directories(browse):
    pages = [_data(browse, '/api/folders', offset=offset, limit=1) for offset in range(3)]
    assert [page['total'] for page in pages] == [3, 3, 3]
    assert [page['has_more'] for page in pages] == [True, True, False]
    assert [page['next_offset'] for page in pages] == [1, 2, 3]
    assert len({page['items'][0]['uri'] for page in pages}) == 3
    empty = _data(browse, '/api/folders', folder='@default/empty-folder')
    assert empty['items'] == [] and empty['total'] == 0
    assert empty['current']['media_count'] == 0
    assert empty['current']['has_children'] is False
    # Audio-only directories can be requested but are not listed as video/image folders.
    audio = _data(browse, '/api/folders', folder='audio')
    assert audio['items'] == [] and audio['current']['media_count'] == 0
    beyond = _data(browse, '/api/folders', folder='@default/', offset=99, limit=1)
    assert beyond['items'] == [] and beyond['total'] == 3
    assert beyond['has_more'] is False


def test_feed_folder_scope_recursion_and_legacy_paths(browse):
    recursive = _data(browse, '/api/feed', folder='a/')
    assert recursive['folder'] == '@default/a'
    assert recursive['recursive'] is True
    assert recursive['order'] == 'sequential' and recursive['filter'] == ''
    assert _names(recursive) == ['@default/a/01.jpg', '@default/a/02.mp4', '@default/a/sub/03.jpg']
    direct = _data(browse, '/api/feed', folder='@default/a', recursive='false', limit=1)
    assert direct['recursive'] is False and direct['total'] == 2
    assert direct['has_more'] is True and direct['next_offset'] == 1
    second = _data(browse, '/api/feed', folder='@default/a', recursive='false', offset=1, limit=1)
    assert _names(second) == ['@default/a/02.mp4']
    assert second['has_more'] is False
    root = _data(browse, '/api/feed', folder='@default/', recursive='false')
    assert _names(root) == ['@default/root.mp4']
    remote = _data(browse, '/api/feed', folder='@nas/a')
    assert _names(remote) == ['@nas/a/remote.jpg']
    empty = _data(browse, '/api/feed', folder='empty-folder')
    assert empty['total'] == 0 and empty['items'] == []


def test_feed_serializes_media_and_independent_reactions(browse):
    uri = '@default/a/02.mp4'
    _reaction(browse, uri, liked_at='2026-11-25T00:00:00Z')
    with browse.database.connect() as conn:
        conn.execute('UPDATE media_items SET width = 640, height = 360 WHERE uri = ?', (uri,))
    page = _data(browse, '/api/feed', limit=96)
    names = _names(page)
    assert names == sorted(names)
    assert page['total'] == 7
    assert all(item['type'] in {'video', 'image'} for item in page['items'])
    item = next(item for item in page['items'] if item['name'] == uri)
    assert item['id'] == item['name'] == uri
    assert item['is_liked'] is True and item['liked_at'] == '2026-11-25T00:00:00Z'
    assert item['is_favorited'] is False and item['favorited_at'] is None
    assert item['width'] == 640 and item['height'] == 360
    assert item['mtime_ts'] > 0 and item['size_bytes'] == 5
    assert item['media_url'].startswith('/media/')
    assert item['thumb_url'].startswith('/thumb?uri=')
    assert item['detail_url'].startswith('/detail/')
    unset = next(item for item in page['items'] if item['name'] == '@default/root.mp4')
    assert unset['is_liked'] is unset['is_favorited'] is False
    assert unset['liked_at'] is unset['favorited_at'] is None


def test_reaction_feeds_sort_by_state_time_then_uri_and_intersect_folders(browse):
    old, new = '2026-11-24T00:00:00Z', '2026-11-25T00:00:00Z'
    _reaction(browse, '@default/a/01.jpg', liked_at=old, favorited_at=new)
    _reaction(browse, '@default/ab/other.jpg', liked_at=new)
    _reaction(browse, '@nas/a/remote.jpg', liked_at=new)
    _reaction(browse, '@default/a/02.mp4', favorited_at=old)
    liked = _data(browse, '/api/feed', filter='liked', limit=1)
    assert liked['total'] == 3
    assert _names(liked) == ['@default/ab/other.jpg']
    rest = _data(browse, '/api/feed', filter='liked', offset=1)
    assert _names(rest) == ['@nas/a/remote.jpg', '@default/a/01.jpg']
    favorite = _data(browse, '/api/feed', filter='favorited')
    assert _names(favorite) == ['@default/a/01.jpg', '@default/a/02.mp4']
    scoped = _data(browse, '/api/feed', filter='liked', folder='@default/a', recursive='false')
    assert _names(scoped) == ['@default/a/01.jpg']
    assert scoped['filter'] == 'liked'
    unliked = _data(browse, '/api/feed', filter='liked', folder='@default/Travel')
    assert unliked['total'] == 0


def test_random_feed_seed_replays_across_pages_without_duplicates(browse):
    expected = _names(_data(browse, '/api/feed', limit=96))
    collected = []
    for offset in range(0, len(expected), 2):
        page = _data(browse, '/api/feed', order='random', seed='fixed', offset=offset, limit=2)
        assert page['total'] == len(expected) and page['seed'] == 'fixed'
        replay = _data(browse, '/api/feed', order='random', seed='fixed', offset=offset, limit=2)
        assert replay == page
        collected.extend(_names(page))
    assert sorted(collected) == expected
    assert len(collected) == len(set(collected))
    different = _names(_data(browse, '/api/feed', order='random', seed='different', limit=96))
    assert different != collected
    generated = _data(browse, '/api/feed', order='random', limit=2)
    assert generated['seed']
    replay = _data(browse, '/api/feed', order='random', seed=generated['seed'], limit=2)
    assert replay == generated


def test_random_feed_keeps_folder_and_reaction_boundaries(browse):
    for uri in ('@default/a/01.jpg', '@default/a/02.mp4', '@default/ab/other.jpg', '@nas/a/remote.jpg'):
        _reaction(browse, uri, liked_at='2026-11-25T00:00:00Z')
    page = _data(
        browse, '/api/feed', folder='@default/a', filter='liked',
        recursive='false', order='random', seed='scoped', limit=1,
    )
    second = _data(
        browse, '/api/feed', folder='@default/a', filter='liked',
        recursive='false', order='random', seed='scoped', offset=1, limit=1,
    )
    assert page['total'] == second['total'] == 2
    assert set(_names(page) + _names(second)) == {'@default/a/01.jpg', '@default/a/02.mp4'}


@pytest.mark.parametrize('folder, other', [
    ('literal%_', 'literalZZ_'),
    ('under_score', 'underXscore'),
    ('Case', 'case'),
    ('旅行2026', '旅行2026版'),
    ('back\\slash', 'back/slash'),
    ("q' OR 1=1 --", 'unrelated'),
])
def test_folder_names_are_case_sensitive_literals_not_sql_patterns(browse, folder, other):
    _index_file(browse, f'{folder}/one.jpg')
    _index_file(browse, f'{folder}/nested/two.mp4')
    _index_file(browse, f'{other}/other.jpg')
    page = _data(browse, '/api/feed', folder=f'@default/{folder}')
    assert set(_names(page)) == {f'@default/{folder}/one.jpg', f'@default/{folder}/nested/two.mp4'}
    assert page['total'] == 2
    direct = _data(browse, '/api/feed', folder=f'@default/{folder}', recursive='false')
    assert _names(direct) == [f'@default/{folder}/one.jpg']
    nodes = _data(browse, '/api/folders', folder=f'@default/{folder}')
    assert nodes['current']['media_count'] == 2
    assert [node['path'] for node in nodes['items']] == [f'{folder}/nested']


@pytest.mark.parametrize('endpoint', ['/api/feed', '/api/folders'])
@pytest.mark.parametrize('folder', [
    '', '/etc', 'C:\\Windows', 'C:relative', '\\\\server\\share',
    '../a', 'a/../ab', 'a\\..\\ab', '@default/../a',
    '@default/C:/Windows', '@default/\x00', '@default',
])
def test_unsafe_folder_inputs_return_400_without_host_paths(browse, endpoint, folder):
    response = browse.client.get(endpoint, query_string={'folder': folder})
    assert response.status_code == 400
    assert response.get_json()['success'] is False
    assert str(browse.roots['default']) not in response.get_data(as_text=True)


@pytest.mark.parametrize('endpoint', ['/api/feed', '/api/folders'])
@pytest.mark.parametrize('folder', ['@unknown/', '@default/missing', '@default/root.mp4'])
def test_unknown_sources_directories_and_files_return_404(browse, endpoint, folder):
    response = browse.client.get(endpoint, query_string={'folder': folder})
    assert response.status_code == 404
    assert response.get_json()['success'] is False


@pytest.mark.parametrize('query', [
    {'recursive': '1'}, {'recursive': 'invalid'}, {'order': 'latest'},
    {'filter': 'favorite'}, {'offset': '-1'}, {'offset': '1.5'},
    {'limit': '0'}, {'limit': '97'}, {'limit': 'bad'},
    {'seed': 'x' * 513}, {'seed': 'bad\x00seed'},
])
def test_invalid_feed_parameters_return_400(browse, query):
    response = browse.client.get('/api/feed', query_string=query)
    assert response.status_code == 400
    assert response.get_json()['success'] is False


@pytest.mark.parametrize('query', [
    {'offset': '-1'}, {'offset': 'invalid'}, {'limit': '0'}, {'limit': '97'},
])
def test_invalid_folder_pagination_returns_400(browse, query):
    assert browse.client.get('/api/folders', query_string=query).status_code == 400


def test_browse_does_not_rescan_sources_and_keeps_offline_index(browse, tmp_path, monkeypatch):
    browse.roots['nas'].rename(tmp_path / 'offline-nas')

    def fail_scan(*args, **kwargs):
        raise AssertionError('GET browsing must not rescan the media library')

    monkeypatch.setattr(browse.library, 'scan_source', fail_scan)
    monkeypatch.setattr(Path, 'iterdir', fail_scan)
    page = _data(browse, '/api/feed', folder='@nas/a')
    assert _names(page) == ['@nas/a/remote.jpg']
    root = _data(browse, '/api/folders', folder='@nas/')
    assert root['current']['media_count'] == 1
    assert [node['uri'] for node in root['items']] == ['@nas/a']
    assert _data(browse, '/api/folders', folder='@empty/')['current']['media_count'] == 0
    assert browse.client.get('/api/feed?folder=@nas/missing').status_code == 404


def test_offline_folder_with_no_direct_or_matching_reactions_is_empty_not_missing(browse, tmp_path):
    browse.roots['default'].rename(tmp_path / 'offline-local')
    for query in (
        {'folder': '@default/Travel', 'recursive': 'false'},
        {'folder': '@default/Travel', 'filter': 'liked'},
        {'folder': '@default/Travel', 'filter': 'favorited', 'order': 'random', 'seed': 'empty'},
    ):
        page = _data(browse, '/api/feed', **query)
        assert page['total'] == 0 and page['items'] == []
    assert _data(browse, '/api/folders', folder='@default/Travel')['current']['media_count'] == 1


def test_current_exclusions_apply_to_cached_offline_rows(browse, tmp_path):
    browse.roots['nas'].rename(tmp_path / 'offline-nas')
    browse.library.sources_by_id['nas'] = replace(
        browse.library.sources_by_id['nas'], exclude=('a/',),
    )
    assert _data(browse, '/api/feed', folder='@nas/')['total'] == 0
    remote = _data(browse, '/api/folders', folder='@nas/')
    assert remote['items'] == [] and remote['current']['media_count'] == 0
    assert browse.client.get('/api/feed?folder=@nas/a').status_code == 404
    assert _data(browse, '/api/feed', folder='@default/a')['total'] == 3
    browse.library.exclude = ('a/',)
    children = _data(browse, '/api/folders', folder='@default/')
    assert 'a' not in [node['path'] for node in children['items']]
    assert _data(browse, '/api/feed', folder='@default/ab')['total'] == 1


def test_symlinked_directory_cannot_escape_or_expose_cached_media(browse, tmp_path):
    original = browse.roots['default'] / 'a'
    outside = tmp_path / 'outside-library'
    original.rename(outside)
    original.symlink_to(outside, target_is_directory=True)
    for endpoint in ('/api/feed', '/api/folders'):
        response = browse.client.get(endpoint, query_string={'folder': '@default/a'})
        assert response.status_code == 400
        assert str(outside) not in response.get_data(as_text=True)
    page = _data(browse, '/api/feed', folder='@default/')
    assert not any(name.startswith('@default/a/') for name in _names(page))
    nodes = _data(browse, '/api/folders', folder='@default/')
    assert 'a' not in [node['path'] for node in nodes['items']]


def test_symlinked_media_cannot_escape_even_when_its_parent_is_safe(browse, tmp_path):
    outside = tmp_path / 'private.jpg'
    outside.write_bytes(b'private')
    media = browse.roots['default'] / 'a' / '01.jpg'
    media.unlink()
    media.symlink_to(outside)
    page = _data(browse, '/api/feed', folder='@default/a')
    assert '@default/a/01.jpg' not in _names(page)
    assert page['total'] == 2
    nodes = _data(browse, '/api/folders', folder='@default/a')
    assert nodes['current']['media_count'] == 2
    assert nodes['current']['cover_uri'] == '@default/a/02.mp4'


def test_feed_state_and_total_share_one_read_snapshot(browse, monkeypatch):
    before, after = '@default/a/01.jpg', '@default/a/02.mp4'
    _reaction(browse, before, liked_at='2026-11-25T00:00:00Z')
    _reaction(browse, after)
    original = browse.library.is_excluded
    updated = False

    def change_reaction_during_read(uri, **kwargs):
        nonlocal updated
        if not updated:
            updated = True
            with browse.database.connect() as conn:
                conn.execute('UPDATE media_reactions SET is_liked = 0 WHERE uri = ?', (before,))
                conn.execute(
                    'UPDATE media_reactions SET is_liked = 1, liked_at = ? WHERE uri = ?',
                    ('2026-11-26T00:00:00Z', after),
                )
        return original(uri, **kwargs)

    monkeypatch.setattr(browse.library, 'is_excluded', change_reaction_during_read)
    first = _data(browse, '/api/feed', filter='liked', limit=1)
    assert first['total'] == 1 and _names(first) == [before]
    assert first['items'][0]['is_liked'] is True
    second = _data(browse, '/api/feed', filter='liked', limit=1)
    assert second['total'] == 1 and _names(second) == [after]
