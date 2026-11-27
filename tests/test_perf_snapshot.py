"""Module K: server-side performance contracts.

K1: the random-flow snapshot is cached per index revision + parent-directory
    signatures; deletions made outside the app still take effect immediately.
K2: thumbnail cold generation is single-flight per URI and bounded to two
    concurrent ffmpeg runs.
"""

from pathlib import Path
import time
from threading import Barrier, Event, Lock, Thread

from spooly.services.database import AppDatabase
from spooly.services.library import LibraryService, MediaSource
from spooly.services.library_index import LibraryIndexer, MediaIndexStore
from spooly.services.shuffle import ShuffleService
from spooly.services.thumbnail import ThumbnailService

def write_media(root: Path, names: list[str]) -> None:
    for name in names:
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(b'media')

def build_env(tmp_path, names, *, private=()):
    root = tmp_path / 'media'
    write_media(root, names)
    library = LibraryService(
        media_sources=[MediaSource('default', 'Default', root)], private=list(private),
    )
    database = AppDatabase(tmp_path / 'state' / 'perf.sqlite3')
    database.migrate()
    media_index = MediaIndexStore(database, private_prefixes=tuple(library.private_folders))
    LibraryIndexer(library, media_index).sync()
    return root, library, media_index

# --- K1: snapshot cache -----------------------------------------------------

def test_records_snapshot_is_shared_until_index_changes(tmp_path, monkeypatch):
    root, library, media_index = build_env(tmp_path, ['open/keep.mp4', 'open/other.jpg'])
    calls = []
    original = media_index.records

    def counting(*args, **kwargs):
        calls.append(1)
        return original(*args, **kwargs)

    monkeypatch.setattr(media_index, 'records', counting)
    service = ShuffleService(library, media_index)
    assert len(service.records()) == 2
    assert len(calls) == 1

    # Another request/service instance reuses the same snapshot.
    assert len(ShuffleService(library, media_index).records()) == 2
    assert len(calls) == 1

    # Index writes bump the revision and force one rebuild.
    media_index.delete('@default/open/keep.mp4')
    assert {row['name'] for row in service.records()} == {'@default/open/other.jpg'}
    assert len(calls) == 2

def test_snapshot_rebuilds_after_out_of_band_file_removal(tmp_path):
    root, library, media_index = build_env(tmp_path, ['open/keep.mp4', 'open/other.jpg'])
    service = ShuffleService(library, media_index)
    assert len(service.records()) == 2
    (root / 'open' / 'keep.mp4').unlink()
    assert {row['name'] for row in service.records()} == {'@default/open/other.jpg'}

def test_snapshot_rebuilds_after_privacy_change(tmp_path):
    root, library, media_index = build_env(tmp_path, ['open/keep.mp4', '私密/secret.mp4'])
    service = ShuffleService(library, media_index)
    assert len(service.records()) == 2
    # Rule changes must invalidate the cache, never leak private URIs from it.
    library.set_private_folders(['@default/私密'])
    assert {row['name'] for row in service.records()} == {'@default/open/keep.mp4'}

def test_snapshot_rebuilds_after_exclude_change(tmp_path):
    root, library, media_index = build_env(tmp_path, ['open/keep.mp4', 'open/other.jpg'])
    service = ShuffleService(library, media_index)
    assert len(service.records()) == 2
    # Exclude patterns match relative paths (library.is_excluded semantics).
    library.exclude = ('open/keep.mp4',)
    assert {row['name'] for row in service.records()} == {'@default/open/other.jpg'}

# --- K2: thumbnail generation throttle --------------------------------------

def test_concurrent_requests_for_one_uri_generate_once(tmp_path, monkeypatch):
    root, library, _ = build_env(tmp_path, ['a.mp4'])
    service = ThumbnailService(root, library)
    calls = []
    release = Event()

    def slow_generate(uri, **kwargs):
        calls.append(uri)
        release.wait(timeout=5)
        return Path(tmp_path / 'fake.jpg')

    monkeypatch.setattr(service, 'generate_thumbnail', slow_generate)
    results = []
    barrier = Barrier(4)  # three workers + the main thread

    def worker():
        barrier.wait(timeout=5)
        results.append(service.get_thumbnail('@default/a.mp4'))

    threads = [Thread(target=worker) for _ in range(3)]
    for thread in threads:
        thread.start()
    barrier.wait(timeout=5)
    # Give every thread time to reach the single-flight wait before releasing.
    time.sleep(0.3)
    release.set()
    for thread in threads:
        thread.join(timeout=5)
    assert calls == ['@default/a.mp4']
    assert len(results) == 3

def test_generation_concurrency_is_bounded(tmp_path, monkeypatch):
    names = [f'clip-{index}.mp4' for index in range(6)]
    root, library, _ = build_env(tmp_path, names)
    service = ThumbnailService(root, library)
    state = {'active': 0, 'max_active': 0}
    lock = Lock()
    release = Event()

    def slow_generate(uri, **kwargs):
        with lock:
            state['active'] += 1
            state['max_active'] = max(state['max_active'], state['active'])
        release.wait(timeout=5)
        with lock:
            state['active'] -= 1
        return None

    monkeypatch.setattr(service, 'generate_thumbnail', slow_generate)
    threads = [
        Thread(target=service.get_thumbnail, args=(f'@default/{name}',))
        for name in names
    ]
    for thread in threads:
        thread.start()
    # Let the gated workers fill both slots and the rest queue up first.
    time.sleep(0.3)
    release.set()
    for thread in threads:
        thread.join(timeout=5)
    assert 2 <= state['max_active'] <= ThumbnailService.GENERATION_SLOTS
