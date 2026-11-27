"""Module H: private folders stay out of aggregate feeds and system collections.

Private media is hidden from every aggregated surface (library grid, full
feeds, the random mix, On This Day, system collections) and only plays inside
a feed scoped to the private folder itself. Reactions still record normally.
"""

from pathlib import Path
import os
from types import SimpleNamespace

from flask import Flask
import pytest
import yaml

from spooly.app import create_app
from spooly.services.browse import BrowseService
from spooly.services.database import AppDatabase
from spooly.services.library import LibraryService, MediaSource, normalize_private_folders
from spooly.services.library_index import LibraryIndexer, MediaIndexStore
from spooly.services.shuffle import ShuffleService
from spooly.web.browse import register_browse_routes

def write_media(root: Path, names: list[str]) -> None:
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'media')

@pytest.fixture
def env(tmp_path):
    root = tmp_path / 'media'
    write_media(root, [
        'open/keep.mp4',
        '私密/secret.mp4',
        '私密/sub/deep.jpg',
        '私密2/lookalike.mp4',
    ])
    library = LibraryService(
        media_sources=[MediaSource('default', 'Default', root)],
        private=['@default/私密'],
    )
    database = AppDatabase(tmp_path / 'state' / 'private.sqlite3')
    database.migrate()
    media_index = MediaIndexStore(database, private_prefixes=tuple(library.private_folders))
    indexer = LibraryIndexer(library, media_index)
    indexer.sync()
    app = Flask(__name__)
    app.config['TESTING'] = True
    register_browse_routes(
        app, library_service=library, media_index=media_index,
        reactions=None, activity_store=None,
    )
    return SimpleNamespace(
        client=app.test_client(), root=root, library=library,
        database=database, media_index=media_index, indexer=indexer,
    )

def feed_names(browse, **kwargs) -> set[str]:
    page = browse.feed(**kwargs)
    return {item['name'] for item in page['items']}

# --- is_private marker semantics -------------------------------------------

def test_is_private_prefix_matches_with_path_boundary(tmp_path):
    root = tmp_path / 'media'
    root.mkdir()
    library = LibraryService(media_root=root)
    assert library.is_private('@default/私密/a.mp4') is False

    library.set_private_folders(['@default/私密'])
    assert library.is_private('@default/私密') is True
    assert library.is_private('@default/私密/') is True
    assert library.is_private('@default/私密/sub/a.mp4') is True
    assert library.is_private('@default/私密2/a.mp4') is False
    assert library.is_private('@default/open/a.mp4') is False
    assert library.is_private('relative/a.mp4') is False

    # Whole media source marker.
    library.set_private_folders(['@default'])
    assert library.is_private('@default/anything/a.mp4') is True

def test_normalize_private_folders_validates_entries():
    assert normalize_private_folders(None) == ()
    assert normalize_private_folders(['@Default/私密/']) == ('@default/私密',)
    assert normalize_private_folders(['@default', '@default/']) == ('@default',)
    assert normalize_private_folders(['@default/私密', '@default/私密']) == ('@default/私密',)
    for bad in ('x', [''], ['私密'], ['@'], ['@default/../etc'], ['@default/a/../b'], [42]):
        with pytest.raises(ValueError):
            normalize_private_folders(bad)

# --- filter point 1: library grid (MediaIndexStore) -------------------------

def test_library_grid_records_and_pages_exclude_private_media(env):
    def visible():
        records = {row['name'] for row in env.media_index.records()}
        page = {row['name'] for row in env.media_index.page(limit=96)['records']}
        assert records == page
        return records

    # The fixture starts with @default/私密 marked private.
    assert visible() == {'@default/open/keep.mp4', '@default/私密2/lookalike.mp4'}

    env.library.set_private_folders([])
    env.media_index.set_private_prefixes(())
    assert visible() == {
        '@default/open/keep.mp4', '@default/私密/secret.mp4',
        '@default/私密/sub/deep.jpg', '@default/私密2/lookalike.mp4',
    }

    env.library.set_private_folders(['@default/私密'])
    env.media_index.set_private_prefixes(tuple(env.library.private_folders))
    assert visible() == {'@default/open/keep.mp4', '@default/私密2/lookalike.mp4'}

def test_on_this_day_and_timeline_exclude_private_media(env):
    with env.database.connect() as conn:
        conn.execute(
            "UPDATE media_items SET captured_local_date = '2020-06-15',"
            " capture_year = '2020', capture_month = '2020-06'"
        )
    on_days = {row['name'] for row in env.media_index.on_days(['06-15'], '2026')}
    assert on_days == {'@default/open/keep.mp4', '@default/私密2/lookalike.mp4'}
    timeline = env.media_index.timeline_months()
    covers = {
        row['name']
        for month in timeline['months'] for row in month['records']
    }
    assert '@default/私密/secret.mp4' not in covers

# --- filter point 2: browse feed (scoped flow passes through) ---------------

def test_aggregate_feed_hides_private_media_but_scoped_feed_plays_it(env):
    browse = BrowseService(env.library, env.media_index)
    all_names = {
        '@default/open/keep.mp4', '@default/私密/secret.mp4',
        '@default/私密/sub/deep.jpg', '@default/私密2/lookalike.mp4',
    }
    assert feed_names(browse) == all_names - {
        '@default/私密/secret.mp4', '@default/私密/sub/deep.jpg',
    }
    # The source root scope is still an aggregate surface for its private child.
    assert feed_names(browse, folder=browse.parse_folder('@default/')) == {
        '@default/open/keep.mp4', '@default/私密2/lookalike.mp4',
    }
    # Only the private folder's own scope plays its media (including subfolders).
    assert feed_names(browse, folder=browse.parse_folder('@default/私密')) == {
        '@default/私密/secret.mp4', '@default/私密/sub/deep.jpg',
    }
    assert feed_names(browse, folder=browse.parse_folder('@default/私密/sub')) == {
        '@default/私密/sub/deep.jpg',
    }
    # A sibling folder scope stays clean.
    assert feed_names(browse, folder=browse.parse_folder('@default/私密2')) == {
        '@default/私密2/lookalike.mp4',
    }

def test_folder_nodes_stay_visible_with_privacy_flag(env):
    browse = BrowseService(env.library, env.media_index)
    listing = browse.folders(folder=browse.parse_folder('@default/'))
    nodes = {node['name']: node for node in listing['items']}
    assert set(nodes) == {'open', '私密', '私密2'}
    assert nodes['私密']['is_private'] is True
    assert nodes['open']['is_private'] is False

# --- filter point 3: random mix (ShuffleService) ----------------------------

def test_mix_shuffle_records_exclude_private_media(env):
    shuffle = ShuffleService(env.library, env.media_index)
    assert {row['name'] for row in shuffle.records()} == {
        '@default/open/keep.mp4', '@default/私密2/lookalike.mp4',
    }
    page = shuffle.page(size=24)
    assert {row['name'] for row in page['records']} == {
        '@default/open/keep.mp4', '@default/私密2/lookalike.mp4',
    }

# --- filter point 4: system collections + web API ---------------------------

@pytest.fixture
def client(tmp_path):
    media = tmp_path / 'media'
    write_media(media, ['open/keep.mp4', '私密/secret.mp4'])
    return create_app({'TESTING': True, 'MEDIA_ROOT': media}).test_client()

def member_names(client, collection_id):
    page = client.get(
        f'/api/collections/{collection_id}/items', query_string={'limit': 96},
    ).get_json()['data']
    return [item['name'] for item in page['items']]

def config_payload() -> dict:
    config_path = Path(os.environ['SPOOLY_INSTANCE']) / 'config.yaml'
    if not config_path.exists():
        return {}
    return yaml.safe_load(config_path.read_text(encoding='utf-8')) or {}

def test_private_likes_stay_out_of_system_collections(client):
    assert client.post('/api/media/@default/open/keep.mp4/like', json={'state': True}).status_code == 200
    assert client.post('/api/media/@default/私密/secret.mp4/like', json={'state': True}).status_code == 200
    assert sorted(member_names(client, 'auto-liked')) == [
        '@default/open/keep.mp4', '@default/私密/secret.mp4',
    ]

    # Marking the folder private drops previously mirrored entries at once.
    assert client.put('/api/private-folders', json={'folders': ['@default/私密']}).status_code == 200
    assert member_names(client, 'auto-liked') == ['@default/open/keep.mp4']

    # Reactions on private media keep recording but never mirror again.
    assert client.post('/api/media/@default/私密/secret.mp4/like', json={'state': True}).status_code == 200
    assert client.post('/api/media/@default/私密/secret.mp4/favorite', json={'state': True}).status_code == 200
    assert member_names(client, 'auto-liked') == ['@default/open/keep.mp4']
    assert member_names(client, 'auto-favorited') == []

def test_private_folders_api_filters_grid_persists_and_survives_restart(tmp_path):
    media = tmp_path / 'media'
    write_media(media, ['open/keep.mp4', '私密/secret.mp4'])
    client = create_app({'TESTING': True, 'MEDIA_ROOT': media}).test_client()

    def grid_names(app_client):
        page = app_client.get('/api/library/items', query_string={'limit': 96})
        return {item['name'] for item in page.json['data']['items']}

    assert grid_names(client) == {'@default/open/keep.mp4', '@default/私密/secret.mp4'}

    listed = client.put('/api/private-folders', json={'folders': ['@default/私密']})
    assert listed.status_code == 200
    items = listed.get_json()['data']['items']
    assert items == [{
        'uri': '@default/私密', 'name': '私密', 'source_id': 'default', 'is_source': False,
    }]
    assert client.get('/api/private-folders').get_json()['data']['items'] == items
    assert grid_names(client) == {'@default/open/keep.mp4'}
    assert config_payload()['private_folders'] == ['@default/私密']

    # Restart: the marker reloads from config.yaml without any rescanning.
    config = config_payload()
    restored = create_app({
        'TESTING': True, 'MEDIA_ROOT': media,
        'MEDIA_PRIVATE_FOLDERS': config.get('private_folders'),
    }).test_client()
    assert grid_names(restored) == {'@default/open/keep.mp4'}
    assert restored.put('/api/private-folders', json={'folders': []}).status_code == 200
    assert grid_names(restored) == {'@default/open/keep.mp4', '@default/私密/secret.mp4'}
    assert config_payload()['private_folders'] == []

def test_private_folders_api_validates_payload(client):
    assert client.put('/api/private-folders', json={}).status_code == 400
    assert client.put('/api/private-folders', json={'folders': 'x'}).status_code == 400
    assert client.put('/api/private-folders', json={'folders': ['nope']}).status_code == 400
    assert client.put('/api/private-folders', json={'folders': [], 'extra': 1}).status_code == 400

def test_flow_view_resolves_folder_scope(tmp_path):
    media = tmp_path / 'media'
    write_media(media, ['私密/secret.mp4'])
    client = create_app({
        'TESTING': True, 'MEDIA_ROOT': media,
        'MEDIA_PRIVATE_FOLDERS': ['@default/私密'],
    }).test_client()
    scoped = client.get('/flow', query_string={'folder': '@default/私密'})
    assert scoped.status_code == 200
    assert b'"is_private": true' in scoped.data
    open_scope = client.get('/flow', query_string={'folder': '@default/'})
    assert b'"is_private": false' in open_scope.data
    full = client.get('/flow')
    assert b'folder: null' in full.data
