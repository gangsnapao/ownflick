import os
from pathlib import Path

import yaml

from spooly.app import create_app
from spooly.config import normalize_media_sources


def write_media(root: Path, names: list[str]) -> None:
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'media')


def library_names(client, **query) -> set[str]:
    response = client.get('/api/library/items', query_string=query)
    assert response.status_code == 200
    return {item['name'] for item in response.json['data']['items']}


def config_sources() -> list[dict]:
    config_path = Path(os.environ['SPOOLY_INSTANCE']) / 'config.yaml'
    if not config_path.exists():
        return []
    return yaml.safe_load(config_path.read_text(encoding='utf-8')).get('media_sources', [])


def make_app(*media_roots):
    """Boot like spooly.run does: config sources win over the CLI media root."""
    config_path = Path(os.environ['SPOOLY_INSTANCE']) / 'config.yaml'
    config = yaml.safe_load(config_path.read_text(encoding='utf-8')) if config_path.exists() else {}
    sources = normalize_media_sources(config or {}, None, media_root=media_roots[0])
    return create_app({
        'TESTING': True, 'MEDIA_ROOT': media_roots[0], 'MEDIA_SOURCES': sources or None,
    }).test_client()


def test_media_source_crud_persists_config_and_hot_updates_index(tmp_path):
    root = tmp_path / 'media'
    extra = tmp_path / 'extra'
    write_media(root, ['clip.mp4'])
    write_media(extra, ['bonus.mp4'])
    client = make_app(root)

    listed = client.get('/api/media-sources').get_json()['data']['items']
    assert [item['id'] for item in listed] == ['default']
    assert listed[0]['path'] == str(root) and listed[0]['media_count'] == 1

    created = client.post('/api/media-sources', json={
        'path': str(extra), 'name': '追加目录', 'exclude': ['*.tmp'],
    })
    assert created.status_code == 200
    items = created.get_json()['data']['items']
    assert [item['id'] for item in items] == ['default', '追加目录']
    assert items[1]['exclude'] == ['*.tmp']
    assert library_names(client) == {'@default/clip.mp4', '@追加目录/bonus.mp4'}
    assert config_sources() == [
        {'id': 'default', 'name': 'Default', 'path': str(root), 'exclude': []},
        {'id': '追加目录', 'name': '追加目录', 'path': str(extra), 'exclude': ['*.tmp']},
    ]

    renamed = client.patch('/api/media-sources/追加目录', json={'name': 'Extra'})
    assert renamed.status_code == 200
    items = renamed.get_json()['data']['items']
    assert [item['name'] for item in items] == ['Default', 'Extra']
    assert config_sources()[1] == {
        'id': '追加目录', 'name': 'Extra', 'path': str(extra), 'exclude': ['*.tmp'],
    }

    deleted = client.delete('/api/media-sources/追加目录')
    assert deleted.status_code == 200
    assert [item['id'] for item in deleted.get_json()['data']['items']] == ['default']
    assert library_names(client) == {'@default/clip.mp4'}
    assert config_sources() == [
        {'id': 'default', 'name': 'Default', 'path': str(root), 'exclude': []},
    ]


def test_media_source_changes_survive_restart_without_resurrection(tmp_path):
    root = tmp_path / 'media'
    extra = tmp_path / 'extra'
    write_media(root, ['clip.mp4'])
    write_media(extra, ['bonus.mp4'])
    client = make_app(root)
    assert client.post('/api/media-sources', json={'path': str(extra)}).status_code == 200

    # Removing the legacy default source must not bring it back on restart.
    assert client.delete('/api/media-sources/default').status_code == 200
    assert library_names(client) == {'@extra/bonus.mp4'}

    restarted = make_app(root)
    items = restarted.get('/api/media-sources').get_json()['data']['items']
    assert [item['id'] for item in items] == ['extra']
    assert library_names(restarted) == {'@extra/bonus.mp4'}


def test_media_source_validation_rejects_invalid_paths(tmp_path):
    root = tmp_path / 'media'
    write_media(root, ['clip.mp4', 'nested/inner.mp4'])
    (root / 'plain.txt').write_text('x')
    outside = tmp_path / 'outside'
    outside.mkdir()
    client = make_app(root)

    for payload, message in [
        ({'path': 'relative/dir'}, '绝对路径'),
        ({'path': str(root / 'missing')}, '不存在'),
        ({'path': str(root / 'plain.txt')}, '不是文件夹'),
        ({'path': str(root / 'nested')}, '互相嵌套'),
        ({'path': str(root)}, '互相嵌套'),
        ({}, 'path'),
    ]:
        response = client.post('/api/media-sources', json=payload)
        assert response.status_code == 400, payload
        assert message in response.get_json()['error']

    # Renaming keeps the same path valid (self is not a nesting conflict).
    assert client.patch('/api/media-sources/default', json={'name': '主目录'}).status_code == 200
    # But moving one source into another stays rejected.
    assert client.post('/api/media-sources', json={'path': str(outside)}).status_code == 200
    moved = client.patch('/api/media-sources/default', json={'path': str(outside / '..')})
    assert moved.status_code == 400
    assert client.patch('/api/media-sources/default', json={'path': str(outside)}).status_code == 400


def test_media_source_delete_keeps_files_and_last_source_is_kept(tmp_path):
    root = tmp_path / 'media'
    extra = tmp_path / 'extra'
    write_media(root, ['clip.mp4'])
    write_media(extra, ['bonus.mp4'])
    client = make_app(root)

    alone = client.delete('/api/media-sources/default')
    assert alone.status_code == 400
    assert '至少需要保留一个文件夹' in alone.get_json()['error']

    assert client.post('/api/media-sources', json={'path': str(extra)}).status_code == 200
    assert client.delete('/api/media-sources/default').status_code == 200
    # Removing a source never touches the filesystem.
    assert (root / 'clip.mp4').read_bytes() == b'media'
    assert client.delete('/api/media-sources/extra').status_code == 400

    missing = client.delete('/api/media-sources/unknown')
    assert missing.status_code == 404


def test_media_source_id_collisions_generate_unique_ids(tmp_path):
    root = tmp_path / 'media'
    first = tmp_path / 'data'
    second = tmp_path / 'other'
    for path in (root, first, second):
        write_media(path, ['a.mp4'])
    client = make_app(root)

    one = client.post('/api/media-sources', json={'path': str(first), 'name': 'data'}).get_json()['data']['items']
    assert [item['id'] for item in one] == ['default', 'data']
    two = client.post('/api/media-sources', json={'path': str(second), 'name': 'data'}).get_json()['data']['items']
    assert [item['id'] for item in two] == ['default', 'data', 'data-2']
