"""Batch trash / purge API: per-item results and partial success."""

from pathlib import Path

import pytest

from spooly.app import create_app
from spooly.services.trash import TRASH_DIR

@pytest.fixture
def client(tmp_path):
    media_root = tmp_path / 'media'
    (media_root / 'album').mkdir(parents=True)
    (media_root / 'album' / 'a.jpg').write_bytes(b'image')
    (media_root / 'clip.mp4').write_bytes(b'video')
    (media_root / 'more.png').write_bytes(b'png')
    return create_app({'TESTING': True, 'MEDIA_ROOT': media_root}).test_client()

def library_uris(client):
    return {item['name'] for item in client.get('/api/library/items').get_json()['data']['items']}

def test_batch_trash_moves_files_and_reports_per_item_results(client):
    media_root = client.application.config['MEDIA_ROOT']
    response = client.post('/api/media/batch', json={
        'action': 'trash',
        'uris': ['@default/clip.mp4', '@default/album/a.jpg'],
    })
    assert response.status_code == 200
    data = response.get_json()
    assert data['action'] == 'trash'
    assert data['succeeded'] == 2 and data['failed'] == 0
    assert all(item['success'] for item in data['results'])
    assert not (media_root / 'clip.mp4').exists()
    assert not (media_root / 'album' / 'a.jpg').exists()
    assert library_uris(client) == {'@default/more.png'}
    # Both files are recoverable from the trash.
    trashed = client.get('/api/trash').get_json()['items']
    assert {item['uri'] for item in trashed} == {'@default/clip.mp4', '@default/album/a.jpg'}

def test_batch_purge_deletes_files_without_trash_entries(client):
    media_root = client.application.config['MEDIA_ROOT']
    response = client.post('/api/media/batch', json={
        'action': 'purge',
        'uris': ['@default/clip.mp4', '@default/more.png'],
    })
    assert response.status_code == 200
    assert response.get_json()['succeeded'] == 2
    assert not (media_root / 'clip.mp4').exists()
    assert not (media_root / 'more.png').exists()
    assert client.get('/api/trash').get_json()['items'] == []
    assert not (media_root / TRASH_DIR).exists() or not any((media_root / TRASH_DIR).iterdir())

def test_batch_partial_failure_keeps_successful_items(client):
    response = client.post('/api/media/batch', json={
        'action': 'trash',
        'uris': ['@default/clip.mp4', '@default/ghost.mp4', '@default/more.png'],
    })
    assert response.status_code == 200
    data = response.get_json()
    assert data['succeeded'] == 2 and data['failed'] == 1
    by_uri = {item['uri']: item for item in data['results']}
    assert by_uri['@default/clip.mp4']['success'] is True
    assert by_uri['@default/more.png']['success'] is True
    assert by_uri['@default/ghost.mp4']['success'] is False
    assert by_uri['@default/ghost.mp4']['error']
    # Successful items stay deleted; the failure leaves its file untouched.
    media_root = client.application.config['MEDIA_ROOT']
    assert not (media_root / 'clip.mp4').exists()
    assert not (media_root / 'more.png').exists()
    assert library_uris(client) == {'@default/album/a.jpg'}

def test_batch_validates_payload(client):
    assert client.post('/api/media/batch', json={'action': 'drop', 'uris': ['x']}).status_code == 400
    assert client.post('/api/media/batch', json={'action': 'trash', 'uris': []}).status_code == 400
    assert client.post('/api/media/batch', json={'action': 'trash'}).status_code == 400
    too_many = [f'file-{index}.mp4' for index in range(201)]
    assert client.post('/api/media/batch', json={'action': 'trash', 'uris': too_many}).status_code == 400
    assert client.post('/api/media/batch', json={'action': 'trash', 'uris': ['ok.mp4', 42]}).status_code == 400
    # Nothing was touched by the rejected requests.
    assert library_uris(client) == {'@default/clip.mp4', '@default/album/a.jpg', '@default/more.png'}
