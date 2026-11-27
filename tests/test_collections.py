from urllib.parse import quote

import pytest

from spooly.app import create_app


@pytest.fixture
def client(tmp_path):
    media_root = tmp_path / 'media'
    media_root.mkdir()
    for name in ['clip.mp4', 'cover.jpg', 'odd & hash#.jpg', 'extra-a.jpg', 'extra-b.jpg', 'song.mp3']:
        (media_root / name).write_bytes(b'media')
    return create_app({'TESTING': True, 'MEDIA_ROOT': media_root}).test_client()


def user_collections(client):
    """User collections only; the list always carries the two system collections."""
    items = client.get('/api/collections').get_json()['data']['items']
    return [item for item in items if not item['system']]


def test_collection_edit_cover_persists_and_delete_removes_collection(client):
    created = client.post('/api/collections', json={'name': 'Inspiration', 'description': 'Clips'})
    assert created.status_code == 200
    item = created.get_json()['data']['item']
    url = f"/api/collections/{item['id']}"
    assert item['item_count'] == 0
    assert user_collections(client) == [item]
    client.post(f'{url}/items', json={
        'uris': ['cover.jpg', 'clip.mp4', 'odd & hash#.jpg', 'extra-a.jpg', 'extra-b.jpg'],
    })

    updated = client.patch(url, json={'name': 'New name', 'cover_uri': 'cover.jpg'})
    assert updated.status_code == 200
    saved = client.get(url).get_json()['data']['item']
    assert saved == updated.get_json()['data']['item']
    assert (saved['name'], saved['description']) == ('New name', 'Clips')
    assert saved['cover_uri'] == saved['preview_items'][0]['uri'] == '@default/cover.jpg'
    assert len(saved['preview_items']) == 4
    assert client.patch(url, json={'cover_uri': 'not-a-member.jpg'}).status_code == 400
    assert client.get(url).get_json()['data']['item'] == saved

    deleted = client.delete(url)
    assert deleted.status_code == 200 and deleted.get_json()['data']['deleted'] is True
    assert client.get(url).status_code == 404
    assert user_collections(client) == []


def test_collection_membership_deduplicates_aliases_and_removal_updates_lookup(client):
    collection_id = client.post('/api/collections', json={'name': 'Favorites'}).get_json()['data']['item']['id']
    url = f'/api/collections/{collection_id}/items'
    added = client.post(url, json={
        'uris': ['./clip.mp4', '@default/clip.mp4', 'odd & hash#.jpg', '', 'odd & hash#.jpg'],
    })
    assert added.status_code == 200
    item = added.get_json()['data']['item']
    assert item['item_count'] == 2
    assert [entry['uri'] for entry in item['preview_items']] == [
        '@default/odd & hash#.jpg', '@default/clip.mp4',
    ]
    assert item['preview_items'][0]['thumb_url'] == '/thumb?uri=' + quote('@default/odd & hash#.jpg')
    lookup = client.get('/api/collections/by-media', query_string={'uri': 'odd & hash#.jpg'})
    assert [entry['id'] for entry in lookup.get_json()['data']['items']] == [collection_id]

    removed = client.delete(url, json={'uris': ['clip.mp4']})
    assert removed.status_code == 200
    assert removed.get_json()['data']['item']['item_count'] == 1
    assert client.get('/api/collections/by-media?uri=clip.mp4').get_json()['data']['items'] == []
    assert client.post(url, json={'uris': 'clip.mp4'}).status_code == 400
    assert client.get('/api/library/items?scope=collection').status_code == 400


def test_collection_flow_feed_excludes_audio_and_preserves_member_order_and_state(client):
    client.post('/api/library/sync')
    collection_id = client.post('/api/collections', json={'name': 'Watch later'}).get_json()['data']['item']['id']
    client.post(f'/api/collections/{collection_id}/items', json={
        'uris': ['clip.mp4', 'song.mp3', 'cover.jpg', 'extra-a.jpg'],
    })

    page = client.get(f'/api/collections/{collection_id}/flow?offset=0&limit=1').get_json()['data']
    assert page['total'] == 3
    assert page['has_more'] is True
    assert [item['name'] for item in page['items']] == ['@default/extra-a.jpg']
    assert page['items'][0]['id'] == page['items'][0]['name']
    assert page['items'][0]['is_liked'] is False
    assert page['items'][0]['is_favorited'] is False

    second = client.get(f'/api/collections/{collection_id}/flow?offset=1&limit=24').get_json()['data']
    assert [item['name'] for item in second['items']] == ['@default/cover.jpg', '@default/clip.mp4']
    assert second['has_more'] is False
    assert client.get('/api/collections/missing/flow').status_code == 404


@pytest.mark.parametrize('endpoint', ['library', 'collection'])
def test_collection_pages_keep_member_order_without_gaps(client, endpoint):
    names = [f'page-{i:02d}.jpg' for i in range(25)]
    for name in names:
        (client.application.config['MEDIA_ROOT'] / name).write_bytes(b'image')
    client.post('/api/library/sync')
    collection_id = client.post('/api/collections', json={'name': 'Media set'}).get_json()['data']['item']['id']
    client.post(f'/api/collections/{collection_id}/items', json={'uris': names})
    detail = client.get(f'/collection/{collection_id}')
    assert detail.status_code == 302
    assert detail.headers['Location'] == '/library'
    # Retiring the collection page must preserve existing membership and order.
    url = (
        f'/api/library/items?scope=collection&collection_id={collection_id}'
        if endpoint == 'library' else f'/api/collections/{collection_id}/items?'
    )
    collected = []
    for offset in (0, 12, 24):
        response = client.get(f'{url}&offset={offset}&limit=12')
        assert response.status_code == 200
        page = response.get_json()['data']
        assert page['total'] == 25
        assert page['next_offset'] == offset + 12
        assert page['has_more'] == (offset < 24)
        collected.extend(item['name'] for item in page['items'])
    assert collected == [f'@default/{name}' for name in reversed(names)]
