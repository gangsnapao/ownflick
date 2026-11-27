"""Module L: curation efficiency contracts.

L2: trash batch restore / purge with per-item results (partial failure kept).
L3: media grid can filter down to one folder subtree.
"""

from pathlib import Path

from spooly.app import create_app

def write_media(root: Path, names: list[str]) -> None:
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'media')

def make_client(tmp_path, names):
    media = tmp_path / 'media'
    write_media(media, names)
    client = create_app({'TESTING': True, 'MEDIA_ROOT': media}).test_client()
    return client, media

def trash_ids(client):
    return {item['uri']: item['id'] for item in client.get('/api/trash').get_json()['items']}

def grid_names(client, **query):
    response = client.get('/api/library/items', query_string={'limit': 96, **query})
    assert response.status_code == 200, response.get_json()
    return {item['name'] for item in response.get_json()['data']['items']}

# --- L2: batch restore / purge ---------------------------------------------

def test_trash_batch_restore_reports_per_item_results(tmp_path):
    client, media = make_client(tmp_path, ['open/keep.mp4', 'open/other.jpg'])
    trashed = client.post('/api/media/batch', json={
        'action': 'trash', 'uris': ['@default/open/keep.mp4', '@default/open/other.jpg'],
    })
    assert trashed.status_code == 200 and trashed.get_json()['succeeded'] == 2
    ids = trash_ids(client)
    # Recreate one original path so restoring it fails with a conflict.
    (media / 'open' / 'keep.mp4').write_bytes(b'conflict')

    response = client.post('/api/trash/batch', json={
        'action': 'restore',
        'ids': [ids['@default/open/keep.mp4'], ids['@default/open/other.jpg']],
    })
    assert response.status_code == 200
    data = response.get_json()
    assert data['succeeded'] == 1 and data['failed'] == 1
    by_id = {item['id']: item for item in data['results']}
    failed = by_id[ids['@default/open/keep.mp4']]
    assert failed['success'] is False and '同名文件' in failed['error']
    assert by_id[ids['@default/open/other.jpg']]['success'] is True
    # The successful restore is back in the grid; the conflicted one stays trashed.
    assert grid_names(client) == {'@default/open/other.jpg'}
    assert set(trash_ids(client)) == {'@default/open/keep.mp4'}

def test_trash_batch_purge_deletes_entries_and_files(tmp_path):
    client, media = make_client(tmp_path, ['open/a.mp4', 'open/b.jpg'])
    trashed = client.post('/api/media/batch', json={
        'action': 'trash', 'uris': ['@default/open/a.mp4', '@default/open/b.jpg'],
    })
    assert trashed.status_code == 200 and trashed.get_json()['succeeded'] == 2
    ids = list(trash_ids(client).values())

    response = client.post('/api/trash/batch', json={'action': 'purge', 'ids': ids})
    assert response.status_code == 200
    assert response.get_json()['succeeded'] == 2
    assert client.get('/api/trash').get_json()['items'] == []
    assert not list((media / '.spooly-trash').iterdir())

def test_trash_batch_validates_payload(tmp_path):
    client, _ = make_client(tmp_path, ['open/a.mp4'])
    assert client.post('/api/trash/batch', json={}).status_code == 400
    assert client.post('/api/trash/batch', json={'action': 'restore', 'ids': []}).status_code == 400
    assert client.post('/api/trash/batch', json={'action': 'drop', 'ids': ['x']}).status_code == 400
    assert client.post('/api/trash/batch', json={'action': 'purge', 'ids': ['x'] * 201}).status_code == 400
    assert client.post('/api/trash/batch', json={'action': 'purge', 'ids': [42]}).status_code == 400

# --- L3: folder-scoped grid -------------------------------------------------

def test_grid_filters_by_folder_subtree(tmp_path):
    client, _ = make_client(tmp_path, ['open/a.mp4', 'open/sub/c.jpg', '私密/b.mp4'])
    assert grid_names(client) == {
        '@default/open/a.mp4', '@default/open/sub/c.jpg', '@default/私密/b.mp4',
    }
    assert grid_names(client, folder='@default/open') == {
        '@default/open/a.mp4', '@default/open/sub/c.jpg',
    }
    assert grid_names(client, folder='@default/open/sub') == {'@default/open/sub/c.jpg'}
    # The source root covers every folder; an invalid folder is ignored.
    assert grid_names(client, folder='@default/') == {
        '@default/open/a.mp4', '@default/open/sub/c.jpg', '@default/私密/b.mp4',
    }
    assert grid_names(client, folder='not-a-uri') == {
        '@default/open/a.mp4', '@default/open/sub/c.jpg', '@default/私密/b.mp4',
    }

def test_grid_folder_filter_combines_with_search(tmp_path):
    client, _ = make_client(tmp_path, ['open/keep.mp4', 'open/sub/clip.mp4', '私密/keep.mp4'])
    assert grid_names(client, folder='@default/open', q='keep') == {'@default/open/keep.mp4'}
