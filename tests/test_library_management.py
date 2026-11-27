import errno
from concurrent.futures import ThreadPoolExecutor
from io import BytesIO
from types import SimpleNamespace

import pytest
from flask import Flask
from PIL import Image
from werkzeug.datastructures import FileStorage, MultiDict

from spooly.auth import configure_auth
from spooly.services.auth import AuthStore
from spooly.services.database import AppDatabase
from spooly.services.library import LibraryService, build_media_sources
from spooly.services.library_index import LibraryIndexer, MediaIndexStore
from spooly.web.library_management import register_library_management_routes


def image_bytes():
    output = BytesIO()
    Image.new('RGB', (2, 2), 'red').save(output, format='PNG')
    return output.getvalue()


@pytest.fixture
def environment(tmp_path):
    root = tmp_path / 'media'
    root.mkdir()
    library = LibraryService(root)
    database = AppDatabase(tmp_path / 'index.sqlite3')
    database.migrate()
    index = MediaIndexStore(database)
    indexer = LibraryIndexer(library, index)
    app = Flask(__name__)
    app.config.update(TESTING=True)
    register_library_management_routes(
        app, library_service=library, library_indexer=indexer, media_index=index,
    )
    return SimpleNamespace(
        app=app, client=app.test_client(), root=root, library=library,
        index=index, indexer=indexer, importer=app.extensions['media_import'],
    )


def upload(client, files):
    return client.post('/api/library/import', data=MultiDict([
        ('files', (BytesIO(content), name)) for name, content in files
    ]), content_type='multipart/form-data')


def names(environment):
    return {record['name'] for record in environment.index.records()}


def assert_no_files(environment):
    assert list(environment.root.iterdir()) == []
    assert names(environment) == set()


def test_imports_multiple_media_files_and_registers_before_success(environment):
    photo = image_bytes()
    response = upload(environment.client, [('假期.PNG', photo), ('片段.mp4', b'video')])
    assert response.status_code == 200
    data = response.get_json()['data']
    assert (data['total'], data['imported'], data['failed']) == (2, 2, 0)
    assert names(environment) == {'@default/假期.PNG', '@default/片段.mp4'}
    for item, content in zip(data['items'], (photo, b'video')):
        assert item['success'] is True
        assert item['message'] == '导入成功'
        assert item['size_bytes'] == len(content)
        assert (environment.root / item['name']).read_bytes() == content
    assert not list(environment.root.glob('*.part'))


def test_import_reports_each_failure_without_blocking_valid_files(environment):
    response = upload(environment.client, [
        ('a.mp3', b'audio'), ('notes.txt', b'text'), ('empty.jpg', b''), ('good.mp4', b'video'),
    ])
    data = response.get_json()['data']
    assert (data['total'], data['imported'], data['failed']) == (4, 1, 3)
    assert [item['success'] for item in data['items']] == [False, False, False, True]
    assert data['items'][0]['error'] == '仅支持导入图片和视频文件。'
    assert data['items'][2]['error'] == '空文件无法导入。'
    assert names(environment) == {'@default/good.mp4'}
    assert [path.name for path in environment.root.iterdir()] == ['good.mp4']


def test_duplicate_names_never_replace_existing_or_same_batch_files(environment):
    (environment.root / 'a.mp4').write_bytes(b'original')
    data = upload(environment.client, [('a.mp4', b'first'), ('a.mp4', b'second')]).get_json()['data']
    assert data['imported'] == 2
    assert [item['name'] for item in data['items']] == ['a (1).mp4', 'a (2).mp4']
    assert (environment.root / 'a.mp4').read_bytes() == b'original'
    assert (environment.root / 'a (1).mp4').read_bytes() == b'first'
    assert (environment.root / 'a (2).mp4').read_bytes() == b'second'


@pytest.mark.parametrize(('name', 'expected'), [
    ('../../外部.jpg', '外部.jpg'),
    (r'C:\\Users\\somebody\\视频.mp4', '视频.mp4'),
    ('/absolute/path/照片.png', '照片.png'),
    ('..\\..\\中文.mov', '中文.mov'),
    ('CON.mp4', '_CON.mp4'),
    ('<unsafe>:name?.webm', '_unsafe__name_.webm'),
])
def test_client_paths_and_unsafe_names_are_sanitized(environment, name, expected):
    response = upload(environment.client, [(name, b'media')])
    item = response.get_json()['data']['items'][0]
    assert item['success'] is True
    assert item['name'] == expected
    assert (environment.root / expected).read_bytes() == b'media'
    assert all(path.parent == environment.root for path in environment.root.iterdir())


def test_very_long_chinese_name_fits_filesystem_limit(environment):
    data = upload(environment.client, [('中文' * 150 + '.mp4', b'video')]).get_json()['data']
    item = data['items'][0]
    assert item['success'] is True
    assert len(item['name'].encode()) <= 200
    assert (environment.root / item['name']).exists()


def test_import_falls_back_to_exclusive_copy_when_filesystem_rejects_hard_links(environment, monkeypatch):
    def unsupported_link(*args, **kwargs):
        raise OSError(errno.EOPNOTSUPP, 'operation not supported')
    monkeypatch.setattr('spooly.services.media_import.os.link', unsupported_link)
    payload = b'copied-on-nas'
    item = upload(environment.client, [('nas.mp4', payload)]).get_json()['data']['items'][0]
    assert item['success'] is True
    assert (environment.root / 'nas.mp4').read_bytes() == payload
    assert names(environment) == {'@default/nas.mp4'}
    assert not list(environment.root.glob('*.part'))


def test_existing_destination_symlink_cannot_overwrite_outside_file(environment, tmp_path):
    outside = tmp_path / 'outside.mp4'
    outside.write_bytes(b'outside')
    (environment.root / 'clip.mp4').symlink_to(outside)
    item = upload(environment.client, [('clip.mp4', b'inside')]).get_json()['data']['items'][0]
    assert item['success'] is True
    assert item['name'] == 'clip (1).mp4'
    assert outside.read_bytes() == b'outside'
    assert (environment.root / 'clip.mp4').is_symlink()
    assert names(environment) == {'@default/clip (1).mp4'}


def test_single_file_limit_uses_actual_bytes_and_cleans_partial_file(environment):
    environment.importer.max_file_bytes = 3
    data = upload(environment.client, [('too-big.mp4', b'1234'), ('fits.jpg', b'123')]).get_json()['data']
    assert (data['imported'], data['failed']) == (1, 1)
    assert data['items'][0]['error'] == '文件超过单个文件的导入大小限制。'
    assert [path.name for path in environment.root.iterdir()] == ['fits.jpg']
    assert names(environment) == {'@default/fits.jpg'}


def test_request_limit_returns_chinese_json_without_any_writes(environment):
    environment.app.config['LIBRARY_IMPORT_MAX_REQUEST_BYTES'] = 512
    response = upload(environment.client, [('large.mp4', b'x' * 1024)])
    assert response.status_code == 413
    assert response.is_json
    assert '分批导入' in response.get_json()['error']
    assert_no_files(environment)


def test_existing_stricter_global_request_limit_is_respected(environment):
    environment.app.config['MAX_CONTENT_LENGTH'] = 512
    response = upload(environment.client, [('large.mp4', b'x' * 1024)])
    assert response.status_code == 413
    assert_no_files(environment)


def test_file_count_limit_rejects_entire_request_before_writing(environment):
    environment.app.config['LIBRARY_IMPORT_MAX_FILES'] = 1
    response = upload(environment.client, [('a.mp4', b'a'), ('b.mp4', b'b')])
    assert response.status_code == 413
    assert '分批导入' in response.get_json()['error']
    assert_no_files(environment)


@pytest.mark.parametrize('request_kind', ['json', 'wrong-field', 'empty'])
def test_missing_files_and_wrong_form_are_rejected(environment, request_kind):
    if request_kind == 'json':
        response = environment.client.post('/api/library/import', json={'files': ['x.mp4']})
    elif request_kind == 'wrong-field':
        response = environment.client.post('/api/library/import', data={'file': (BytesIO(b'video'), 'x.mp4')})
    else:
        response = upload(environment.client, [])
    assert response.status_code == 400
    assert response.get_json()['success'] is False
    assert_no_files(environment)


def test_excluded_file_is_not_left_on_disk_or_reported_as_imported(environment):
    environment.library.exclude = ('*.jpg',)
    data = upload(environment.client, [('hidden.jpg', b'image')]).get_json()['data']
    assert data['failed'] == 1
    assert '排除规则' in data['items'][0]['error']
    assert_no_files(environment)


def test_missing_source_does_not_create_an_unmounted_directory(environment):
    environment.root.rmdir()
    item = upload(environment.client, [('a.mp4', b'video')]).get_json()['data']['items'][0]
    assert item['success'] is False
    assert '媒体目录不可用' in item['error']
    assert not environment.root.exists()
    assert names(environment) == set()


def test_permission_failure_is_chinese_and_does_not_leak_paths(environment, monkeypatch):
    def denied(*args, **kwargs):
        raise PermissionError(errno.EACCES, 'Permission denied', str(environment.root))
    monkeypatch.setattr('spooly.services.media_import.tempfile.NamedTemporaryFile', denied)
    item = upload(environment.client, [('a.mp4', b'video')]).get_json()['data']['items'][0]
    assert item['success'] is False
    assert item['error'] == '媒体目录不可写，请检查目录权限。'
    assert str(environment.root) not in item['error']
    assert_no_files(environment)


def test_interrupted_read_cleans_temporary_data(environment):
    class InterruptedStream(BytesIO):
        def read(self, size=-1):
            if self.tell():
                raise OSError('connection interrupted')
            return super().read(size)
    result = environment.importer.import_file(FileStorage(
        stream=InterruptedStream(b'partial-video'), filename='a.mp4',
    ))
    assert result['success'] is False
    assert_no_files(environment)


def test_index_failure_after_commit_rolls_back_only_failed_file(environment, monkeypatch):
    original_register = environment.indexer.register_uris
    def failing_register(uris):
        result = original_register(uris)
        if uris[0].endswith('/bad.mp4'):
            raise RuntimeError('notification failed after index commit')
        return result
    monkeypatch.setattr(environment.indexer, 'register_uris', failing_register)
    data = upload(environment.client, [('bad.mp4', b'bad'), ('good.mp4', b'good')]).get_json()['data']
    assert (data['imported'], data['failed']) == (1, 1)
    assert data['items'][0]['error'] == '文件建立索引失败，请重新导入。'
    assert [path.name for path in environment.root.iterdir()] == ['good.mp4']
    assert names(environment) == {'@default/good.mp4'}


def test_indexer_skipping_file_is_not_counted_as_success(environment, monkeypatch):
    monkeypatch.setattr(environment.indexer, 'register_uris', lambda uris: 0)
    data = upload(environment.client, [('a.mp4', b'video')]).get_json()['data']
    assert (data['imported'], data['failed']) == (0, 1)
    assert_no_files(environment)


def test_concurrent_duplicate_imports_preserve_every_file(environment):
    def import_one(number):
        return environment.importer.import_file(FileStorage(
            stream=BytesIO(str(number).encode()), filename='same.mp4',
        ))
    with ThreadPoolExecutor(max_workers=4) as executor:
        results = list(executor.map(import_one, range(8)))
    assert all(result['success'] for result in results)
    assert len({result['uri'] for result in results}) == 8
    assert {path.read_bytes() for path in environment.root.iterdir()} == {str(number).encode() for number in range(8)}
    assert len(names(environment)) == 8


def test_configured_source_alias_returns_the_actual_indexed_uri(environment):
    environment.library.sources = build_media_sources(environment.root, [
        {'id': 'photos', 'name': '照片', 'path': str(environment.root)},
    ])
    environment.library.sources_by_id = {source.id: source for source in environment.library.sources}
    item = upload(environment.client, [('a.jpg', b'image')]).get_json()['data']['items'][0]
    assert item['success'] is True
    assert item['uri'] == '@photos/a.jpg'
    assert names(environment) == {item['uri']}


def test_auth_and_csrf_protect_uploads_before_writing(tmp_path):
    root = tmp_path / 'private-media'
    root.mkdir()
    library = LibraryService(root)
    database = AppDatabase(tmp_path / 'private.sqlite3')
    database.migrate()
    index = MediaIndexStore(database)
    indexer = LibraryIndexer(library, index)
    auth = AuthStore(tmp_path / 'auth.json')
    auth.ensure('test-password')
    app = Flask(__name__)
    app.config.update(TESTING=True)
    configure_auth(app, auth, enabled=True)
    register_library_management_routes(
        app, library_service=library, library_indexer=indexer, media_index=index,
    )
    client = app.test_client()
    assert upload(client, [('a.mp4', b'video')]).status_code == 401
    with client.session_transaction() as session:
        session['authenticated'] = True
        session['auth_revision'] = auth.revision
        session['_csrf_token'] = 'secret-token'
    assert upload(client, [('a.mp4', b'video')]).status_code == 403
    assert list(root.iterdir()) == []
    accepted = client.post('/api/library/import', data={
        '_csrf_token': 'secret-token', 'files': (BytesIO(b'video'), 'a.mp4'),
    })
    assert accepted.get_json()['data']['imported'] == 1
    app.config['LIBRARY_IMPORT_MAX_REQUEST_BYTES'] = 512
    too_large = client.post('/api/library/import', data={
        '_csrf_token': 'secret-token', 'files': (BytesIO(b'x' * 1024), 'large.mp4'),
    })
    assert too_large.status_code == 413
    assert too_large.is_json
    assert {path.name for path in root.iterdir()} == {'a.mp4'}
