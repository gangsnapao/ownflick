"""System collections mirror likes and favorites and stay playable on their own."""

from pathlib import Path

import pytest

from spooly.app import create_app
from spooly.paths import get_collections_path, get_database_path
from spooly.services.database import AppDatabase
from spooly.services.library import LibraryService
from spooly.services.reactions import MediaReactionStore


def write_media(root: Path, names: list[str]) -> None:
    root.mkdir(parents=True, exist_ok=True)
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'media')


@pytest.fixture
def client(tmp_path):
    media = tmp_path / 'media'
    write_media(media, ['clip.mp4', 'cover.jpg'])
    return create_app({'TESTING': True, 'MEDIA_ROOT': media}).test_client()


def collection(client, collection_id):
    return client.get(f'/api/collections/{collection_id}').get_json()['data']['item']


def member_names(client, collection_id):
    page = client.get(
        f'/api/collections/{collection_id}/items', query_string={'limit': 96},
    ).get_json()['data']
    return [item['name'] for item in page['items']]


def system_ids(client):
    items = client.get('/api/collections').get_json()['data']['items']
    return [(item['id'], item['system'], item['name']) for item in items if item['system']]


def test_like_and_favorite_feed_their_system_collections(client):
    assert system_ids(client) == [
        ('auto-liked', 'liked', '我的点赞'),
        ('auto-favorited', 'favorited', '我的收藏'),
    ]
    assert client.post('/api/media/@default/clip.mp4/like', json={'state': True}).status_code == 200
    assert client.post('/api/media/@default/cover.jpg/favorite', json={'state': True}).status_code == 200

    assert member_names(client, 'auto-liked') == ['@default/clip.mp4']
    assert member_names(client, 'auto-favorited') == ['@default/cover.jpg']
    assert collection(client, 'auto-liked')['item_count'] == 1
    assert collection(client, 'auto-favorited')['item_count'] == 1

    # Un-liking removes the mirrored entry.
    assert client.post('/api/media/@default/clip.mp4/like', json={'state': False}).status_code == 200
    assert member_names(client, 'auto-liked') == []
    assert collection(client, 'auto-liked')['item_count'] == 0


def test_system_collection_manual_edits_are_guarded(client):
    assert client.post('/api/media/@default/clip.mp4/like', json={'state': True}).status_code == 200

    added = client.post('/api/collections/auto-liked/items', json={'uris': ['@default/cover.jpg']})
    assert added.status_code == 400
    assert '点赞或收藏' in added.get_json()['error']

    renamed = client.patch('/api/collections/auto-liked', json={'name': 'New'})
    assert renamed.status_code == 400
    deleted = client.delete('/api/collections/auto-liked')
    assert deleted.status_code == 400
    assert collection(client, 'auto-liked')['name'] == '我的点赞'

    # Removing an item clears the matching reaction (and therefore the entry).
    removed = client.delete('/api/collections/auto-liked/items', json={'uris': ['@default/clip.mp4']})
    assert removed.status_code == 200
    assert removed.get_json()['data']['item']['item_count'] == 0
    assert member_names(client, 'auto-liked') == []
    assert client.get('/api/collections/auto-liked/flow').get_json()['data']['items'] == []


def test_system_collections_are_reconciled_on_restart(tmp_path):
    media = tmp_path / 'media'
    write_media(media, ['clip.mp4', 'cover.jpg'])
    client = create_app({'TESTING': True, 'MEDIA_ROOT': media}).test_client()
    assert client.post('/api/media/@default/clip.mp4/like', json={'state': True}).status_code == 200
    assert client.post('/api/media/@default/clip.mp4/favorite', json={'state': True}).status_code == 200

    # Simulate drift: wipe the collections store before the next boot.
    get_collections_path().write_text('{"version": 1, "collections": []}', encoding='utf-8')

    rebooted = create_app({'TESTING': True, 'MEDIA_ROOT': media}).test_client()
    assert member_names(rebooted, 'auto-liked') == ['@default/clip.mp4']
    assert member_names(rebooted, 'auto-favorited') == ['@default/clip.mp4']

    # Bulk favorite replacement resyncs the mirror on the next boot.
    database = AppDatabase(get_database_path())
    database.migrate()
    store = MediaReactionStore(database, LibraryService(media))
    store.replace_favorites({'@default/cover.jpg'})
    synced = create_app({'TESTING': True, 'MEDIA_ROOT': media}).test_client()
    assert member_names(synced, 'auto-favorited') == ['@default/cover.jpg']
    assert member_names(synced, 'auto-liked') == ['@default/clip.mp4']


def test_system_collections_pin_first_and_keep_collection_flow(client):
    client.post('/api/collections', json={'name': '手动合集'})
    client.post('/api/media/@default/clip.mp4/favorite', json={'state': True})
    items = client.get('/api/collections').get_json()['data']['items']
    assert [(item['id'], item['system']) for item in items[:2]] == [
        ('auto-liked', 'liked'), ('auto-favorited', 'favorited'),
    ]
    assert items[2]['name'] == '手动合集' and not items[2]['system']

    flow = client.get('/api/collections/auto-favorited/flow').get_json()['data']['items']
    assert [item['name'] for item in flow] == ['@default/clip.mp4']
    assert flow[0]['is_favorited'] is True
