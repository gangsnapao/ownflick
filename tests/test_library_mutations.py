"""Filesystem/index mutation races and recoverable storage failures."""

import errno
import json
import shutil
import threading
from concurrent.futures import Future
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import quote

import pytest
from werkzeug.datastructures import FileStorage

from spooly.app import create_app
from spooly.services.database import AppDatabase
from spooly.services.library import LibraryService
from spooly.services.library_index import LibraryIndexer, MediaIndexStore
from spooly.services.media_import import MediaImportService
from spooly.services.trash import TRASH_DIR, TrashService


WAIT_SECONDS = 5


@pytest.fixture
def environment(tmp_path):
    root = tmp_path / 'media'
    root.mkdir()
    library = LibraryService(root)
    database = AppDatabase(tmp_path / 'index.sqlite3')
    database.migrate()
    index = MediaIndexStore(database)
    indexer = LibraryIndexer(library, index)
    return SimpleNamespace(
        root=root, library=library, index=index, indexer=indexer,
        importer=MediaImportService(library, indexer, index, max_file_bytes=1024),
        trash=TrashService(library),
    )


@pytest.fixture
def run_task():
    """Keep failed concurrency assertions bounded even if a lock regresses."""
    threads = []

    def start(operation):
        future = Future()

        def run():
            try:
                future.set_result(operation())
            except BaseException as error:
                future.set_exception(error)

        thread = threading.Thread(target=run, daemon=True)
        threads.append(thread)
        thread.start()
        return future

    yield start
    for thread in threads:
        thread.join(timeout=WAIT_SECONDS)
    assert all(not thread.is_alive() for thread in threads), 'media mutation did not finish'


def indexed_names(environment):
    return {record['name'] for record in environment.index.records()}


def upload(environment, name='new.mp4', content=b'complete-video'):
    return environment.importer.import_file(FileStorage(
        filename=name, stream=BytesIO(content),
    ))


@pytest.mark.parametrize('mutation', ['register', 'import'])
def test_completed_scan_cannot_erase_a_concurrent_registration(
    environment, monkeypatch, run_task, mutation,
):
    (environment.root / 'existing.mp4').write_bytes(b'existing')
    environment.indexer.sync()
    snapshot_ready = threading.Event()
    release_snapshot = threading.Event()
    mutation_started = threading.Event()
    mutation_finished = threading.Event()
    original_replace = environment.index.replace_snapshot

    def paused_replace(*args, **kwargs):
        snapshot_ready.set()
        assert release_snapshot.wait(WAIT_SECONDS), 'scan was not released'
        return original_replace(*args, **kwargs)

    def mutate():
        mutation_started.set()
        try:
            if mutation == 'register':
                return environment.indexer.register_uris(['@default/new.mp4'])
            return upload(environment)
        finally:
            mutation_finished.set()

    monkeypatch.setattr(environment.index, 'replace_snapshot', paused_replace)
    scan = run_task(environment.indexer.sync)
    try:
        assert snapshot_ready.wait(WAIT_SECONDS)
        if mutation == 'register':
            (environment.root / 'new.mp4').write_bytes(b'complete-video')
        registration = run_task(mutate)
        assert mutation_started.wait(WAIT_SECONDS)
        completed_before_snapshot = mutation_finished.wait(0.2)
    finally:
        release_snapshot.set()

    assert scan.result(WAIT_SECONDS)['indexed'] == 1
    result = registration.result(WAIT_SECONDS)
    if mutation == 'register':
        assert result == 1
    else:
        assert result['success'] is True
    assert not completed_before_snapshot
    assert indexed_names(environment) == {'@default/existing.mp4', '@default/new.mp4'}
    assert (environment.root / 'new.mp4').read_bytes() == b'complete-video'


@pytest.mark.parametrize('failure', [None, 'copy_oserror', 'copy_runtimeerror', 'fsync'])
def test_nas_copy_is_scanned_only_after_publication_or_rollback(
    environment, monkeypatch, run_task, failure,
):
    (environment.root / 'existing.mp4').write_bytes(b'existing')
    environment.indexer.sync()
    partial_written = threading.Event()
    release_copy = threading.Event()
    scan_started = threading.Event()
    scan_finished = threading.Event()
    content = b'complete-video'

    def unsupported_link(*args, **kwargs):
        raise OSError(errno.EOPNOTSUPP, 'hard links unavailable')

    def paused_copy(source, output, _length):
        output.write(source.read(4))
        output.flush()
        partial_written.set()
        assert release_copy.wait(WAIT_SECONDS), 'copy was not released'
        if failure == 'copy_oserror':
            raise OSError(errno.ENOSPC, 'copy failed')
        if failure == 'copy_runtimeerror':
            raise RuntimeError('copy interrupted unexpectedly')
        output.write(source.read())

    def failed_fsync(_descriptor):
        raise OSError(errno.ENOSPC, 'flush failed')

    def scan_library():
        scan_started.set()
        try:
            return environment.indexer.sync()
        finally:
            scan_finished.set()

    monkeypatch.setattr('spooly.services.media_import.os.link', unsupported_link)
    monkeypatch.setattr('spooly.services.media_import.shutil.copyfileobj', paused_copy)
    if failure == 'fsync':
        monkeypatch.setattr('spooly.services.media_import.os.fsync', failed_fsync)
    importing = run_task(lambda: upload(environment, name='nas.mp4', content=content))
    try:
        assert partial_written.wait(WAIT_SECONDS)
        assert (environment.root / 'nas.mp4').stat().st_size == 4
        scanning = run_task(scan_library)
        assert scan_started.wait(WAIT_SECONDS)
        scanned_before_copy_finished = scan_finished.wait(0.2)
        visible_during_copy = indexed_names(environment)
    finally:
        release_copy.set()

    result = importing.result(WAIT_SECONDS)
    scanning.result(WAIT_SECONDS)
    assert not scanned_before_copy_finished
    assert visible_during_copy == {'@default/existing.mp4'}
    assert result['success'] is (failure is None)
    expected_names = {'@default/existing.mp4'}
    expected_files = {'existing.mp4'}
    if failure is None:
        expected_names.add('@default/nas.mp4')
        expected_files.add('nas.mp4')
        assert (environment.root / 'nas.mp4').read_bytes() == content
        records = {record['name']: record for record in environment.index.records()}
        assert records['@default/nas.mp4']['size_bytes'] == len(content)
    assert indexed_names(environment) == expected_names
    assert {path.name for path in environment.root.iterdir()} == expected_files


def test_concurrent_nas_imports_keep_original_and_every_duplicate(
    environment, monkeypatch, run_task,
):
    original = environment.root / 'same.mp4'
    original.write_bytes(b'original')
    environment.indexer.sync()
    start_imports = threading.Event()

    def unsupported_link(*args, **kwargs):
        raise OSError(errno.EOPNOTSUPP, 'hard links unavailable')

    def import_duplicate(content):
        assert start_imports.wait(WAIT_SECONDS)
        return upload(environment, name='same.mp4', content=content)

    monkeypatch.setattr('spooly.services.media_import.os.link', unsupported_link)
    payloads = [f'upload-{number}'.encode() for number in range(4)]
    imports = [run_task(lambda content=content: import_duplicate(content)) for content in payloads]
    start_imports.set()
    results = [future.result(WAIT_SECONDS) for future in imports]
    assert all(result['success'] for result in results)
    assert {result['name'] for result in results} == {
        f'same ({number}).mp4' for number in range(1, 5)
    }
    for result, content in zip(results, payloads):
        assert (environment.root / result['name']).read_bytes() == content
    assert original.read_bytes() == b'original'
    assert len(indexed_names(environment)) == 5
    assert len(list(environment.root.iterdir())) == 5


def test_failed_registration_finishes_rollback_before_scanning(
    environment, monkeypatch, run_task,
):
    registered = threading.Event()
    release_registration = threading.Event()
    scan_started = threading.Event()
    scan_finished = threading.Event()
    original_register = environment.indexer.register_uris

    def fail_after_registration(uris):
        original_register(uris)
        registered.set()
        assert release_registration.wait(WAIT_SECONDS), 'registration was not released'
        raise RuntimeError('notification failed after committing the index')

    def scan_library():
        scan_started.set()
        try:
            return environment.indexer.sync()
        finally:
            scan_finished.set()

    monkeypatch.setattr(environment.indexer, 'register_uris', fail_after_registration)
    importing = run_task(lambda: upload(environment))
    try:
        assert registered.wait(WAIT_SECONDS)
        scanning = run_task(scan_library)
        assert scan_started.wait(WAIT_SECONDS)
        scanned_before_rollback = scan_finished.wait(0.2)
    finally:
        release_registration.set()

    result = importing.result(WAIT_SECONDS)
    scanning.result(WAIT_SECONDS)
    assert result['success'] is False
    assert result['error'] == '文件建立索引失败，请重新导入。'
    assert not scanned_before_rollback
    assert indexed_names(environment) == set()
    assert list(environment.root.iterdir()) == []


@pytest.mark.parametrize('mutation', ['delete', 'restore'])
def test_scan_commit_and_trash_requests_are_serialized(
    tmp_path, monkeypatch, run_task, mutation,
):
    root = tmp_path / 'web-media'
    root.mkdir()
    target = root / 'clip.mp4'
    target.write_bytes(b'original-video')
    uri = '@default/clip.mp4'
    app = create_app({
        'TESTING': True, 'AUTH_ENABLED': False, 'MEDIA_ROOT': root,
        'MEDIA_SOURCES': [], 'MEDIA_EXCLUDE': None, 'EXPERIMENTS': {},
        'APP_DATABASE': AppDatabase(tmp_path / 'web.sqlite3'),
    })
    importer = app.extensions['media_import']
    delete_url = f'/delete/{quote(uri, safe="/")}'
    mutation_url = delete_url
    if mutation == 'restore':
        with app.test_client() as client:
            response = client.post(delete_url, headers={'Accept': 'application/json'})
            assert response.status_code == 200
            mutation_url = f"/api/trash/{response.get_json()['id']}/restore"

    snapshot_ready = threading.Event()
    release_snapshot = threading.Event()
    mutation_started = threading.Event()
    mutation_finished = threading.Event()
    original_replace = importer.media_index.replace_snapshot

    def paused_replace(*args, **kwargs):
        snapshot_ready.set()
        assert release_snapshot.wait(WAIT_SECONDS), 'scan was not released'
        return original_replace(*args, **kwargs)

    def scan_library():
        with app.test_client() as client:
            response = client.post('/api/library/sync')
            assert response.status_code == 200
            return response.get_json()['data']

    def mutate_library():
        mutation_started.set()
        try:
            with app.test_client() as client:
                response = client.post(mutation_url, headers={'Accept': 'application/json'})
                return response.status_code, response.get_json()
        finally:
            mutation_finished.set()

    monkeypatch.setattr(importer.media_index, 'replace_snapshot', paused_replace)
    scanning = run_task(scan_library)
    try:
        assert snapshot_ready.wait(WAIT_SECONDS)
        mutating = run_task(mutate_library)
        assert mutation_started.wait(WAIT_SECONDS)
        mutation_completed_during_scan = mutation_finished.wait(0.2)
        original_path_present_during_scan = target.exists()
    finally:
        release_snapshot.set()

    scan_result = scanning.result(WAIT_SECONDS)
    status, result = mutating.result(WAIT_SECONDS)
    assert status == 200
    assert not mutation_completed_during_scan
    assert original_path_present_during_scan is (mutation == 'delete')
    assert scan_result['indexed'] == (1 if mutation == 'delete' else 0)
    with app.test_client() as client:
        indexed = client.get('/api/library/items?scope=all').get_json()['data']['items']
        trashed = client.get('/api/trash').get_json()['items']
    if mutation == 'delete':
        assert indexed == []
        assert not target.exists()
        assert [(entry['id'], entry['uri']) for entry in trashed] == [(result['id'], uri)]
        trash_folder = root / TRASH_DIR / result['id'].partition('.')[2]
        assert (trash_folder / target.name).read_bytes() == b'original-video'
    else:
        assert [item['name'] for item in indexed] == [uri]
        assert result['uri'] == uri
        assert target.read_bytes() == b'original-video'
        assert trashed == []


@pytest.mark.parametrize('failure', ['manifest_write', 'manifest_fsync'])
def test_trash_manifest_failure_preserves_original_and_previous_entries(
    environment, monkeypatch, failure,
):
    previous = environment.root / 'previous.mp4'
    previous.write_bytes(b'previous')
    previous_entry = environment.trash.move('previous.mp4')
    original = environment.root / 'clip.mp4'
    original.write_bytes(b'original')
    environment.indexer.sync()
    original_open = Path.open

    def partial_manifest(path, mode='r', *args, **kwargs):
        if path.name == 'entry.json' and 'w' in mode:
            with original_open(path, mode, *args, **kwargs) as output:
                output.write('{')
            raise OSError(errno.ENOSPC, 'manifest write failed')
        return original_open(path, mode, *args, **kwargs)

    def failed_fsync(_descriptor):
        raise OSError(errno.ENOSPC, 'manifest flush failed')

    if failure == 'manifest_write':
        monkeypatch.setattr(Path, 'open', partial_manifest)
    else:
        monkeypatch.setattr('spooly.services.trash.os.fsync', failed_fsync)
    with pytest.raises(OSError) as error:
        environment.trash.move('clip.mp4')
    assert error.value.errno == errno.ENOSPC
    assert original.read_bytes() == b'original'
    assert environment.trash.entries() == [previous_entry]
    assert [folder.name for folder in (environment.root / TRASH_DIR).iterdir()] == [
        previous_entry['id'].partition('.')[2],
    ]
    environment.indexer.sync()
    assert indexed_names(environment) == {'@default/clip.mp4'}


@pytest.mark.parametrize('moved_before_failure', [False, True])
def test_trash_move_failure_cleans_only_empty_entry_directories(
    environment, monkeypatch, moved_before_failure,
):
    original = environment.root / 'clip.mp4'
    original.write_bytes(b'original')
    original_move = shutil.move

    def failed_move(source, destination):
        manifest = Path(destination).parent / 'entry.json'
        assert json.loads(manifest.read_text(encoding='utf-8'))['uri'] == '@default/clip.mp4'
        if moved_before_failure:
            original_move(source, destination)
        raise OSError(errno.EIO, 'move failed')

    monkeypatch.setattr('spooly.services.trash.shutil.move', failed_move)
    with pytest.raises(OSError, match='move failed'):
        environment.trash.move('clip.mp4')
    if moved_before_failure:
        assert not original.exists()
        entries = environment.trash.entries()
        assert len(entries) == 1
        monkeypatch.setattr('spooly.services.trash.shutil.move', original_move)
        assert environment.trash.restore(entries[0]['id']) == '@default/clip.mp4'
        assert original.read_bytes() == b'original'
    else:
        assert original.read_bytes() == b'original'
    assert environment.trash.entries() == []
    assert list((environment.root / TRASH_DIR).iterdir()) == []
