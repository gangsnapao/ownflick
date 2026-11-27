"""Stable full-library shuffle with keyset pagination and recoverable anchors."""

# Module K1: the visible record set is cached per index revision and per set
# of parent directories (unlink/create/rename bump the directory mtime), so
# requests stop paying a full scan + per-file stat while deletions made outside
# the app still take effect on the very next request.

from bisect import bisect_left, bisect_right
import hashlib
import os
import secrets
from threading import RLock
from weakref import WeakKeyDictionary


class ShuffleService:
    """Each URI gets an equally distributed key independent of file metadata.

    A stable library is a permutation, not independent samples. Keyset cursors
    survive removals before the cursor. New files before the cursor join the
    next round; new files after it can join the current round.
    """

    def __init__(self, library, media_index):
        self.library = library
        self.media_index = media_index

    @staticmethod
    def new_seed() -> str:
        return secrets.token_hex(32)

    @staticmethod
    def key(seed: str, uri: str, avoid_uri: str = '') -> tuple:
        # A seed always identifies the same order, including after library edits.
        digest = hashlib.sha256((seed + '\x00' + uri).encode('utf-8')).digest()
        return (digest, uri)

    # Per-index snapshot cache (module K1). Requests are frequent but the
    # index only changes on rescan/edit and availability only changes when a
    # parent directory changes, so the visible set is rebuilt lazily.
    _SNAPSHOT_CACHES: WeakKeyDictionary = WeakKeyDictionary()
    _SNAPSHOT_LOCK = RLock()

    def _signature(self) -> tuple:
        library = self.library
        sources = tuple(
            (source.id, str(source.path), tuple(source.exclude or ()))
            for source in library.sources
        )
        return (
            self.media_index.revision, library.exclude, library.private_folders, sources,
        )

    @staticmethod
    def _dir_signature(dirs) -> tuple:
        signature = []
        for directory in dirs:
            try:
                stat = directory.stat()
                signature.append((str(directory), stat.st_mtime_ns, stat.st_ino))
            except OSError:
                signature.append((str(directory), None, None))
        return tuple(signature)

    def _build_records(self) -> tuple[list[dict], tuple]:
        visible = {}
        dirs = set()
        for record in self.media_index.records():
            if record.get('media_type') not in {'video', 'image'}:
                continue
            uri = str(record.get('name') or '')
            if not uri or self.library.is_excluded(uri) or self.library.is_private(uri):
                continue
            path = self.library.resolve_path(uri)
            try:
                if path is None or not path.is_file() or not os.access(path, os.R_OK):
                    continue
            except OSError:
                continue
            dirs.add(path.parent)
            visible[uri] = record
        return list(visible.values()), tuple(sorted(dirs))

    def records(self) -> list[dict]:
        signature = self._signature()
        with self._SNAPSHOT_LOCK:
            snapshot = self._SNAPSHOT_CACHES.get(self.media_index)
            if (
                snapshot is not None
                and snapshot['signature'] == signature
                and self._dir_signature(snapshot['dirs']) == snapshot['dirs_sig']
            ):
                return list(snapshot['records'])
        records, dirs = self._build_records()
        snapshot = {
            'signature': signature, 'dirs': dirs,
            'dirs_sig': self._dir_signature(dirs), 'records': records,
        }
        with self._SNAPSHOT_LOCK:
            self._SNAPSHOT_CACHES[self.media_index] = snapshot
        return list(records)

    def page(
        self, *, seed: str = '', size: int = 24, page: int = 1,
        after: str = '', resume_uri: str = '', avoid_uri: str = '',
    ) -> dict:
        new_round = not seed
        seed = seed or self.new_seed()
        records = self.records()
        records.sort(key=lambda row: self.key(seed, row['name'], avoid_uri))
        # Reject only a colliding new permutation. Moving the boundary item to
        # the end would keep it last in every later round, regardless of seed.
        while new_round and len(records) > 1 and records[0]['name'] == avoid_uri:
            seed = self.new_seed()
            records.sort(key=lambda row: self.key(seed, row['name'], avoid_uri))
        names = [row['name'] for row in records]
        keys = [self.key(seed, name, avoid_uri) for name in names]
        total = len(records)
        resume_found = bool(resume_uri and resume_uri in names)
        start = max(0, (page - 1) * size)
        if resume_uri:
            start = bisect_left(keys, self.key(seed, resume_uri, avoid_uri))
            # A deleted last item falls back to the first valid file.
            if start >= total:
                start = 0
        elif after:
            start = bisect_right(keys, self.key(seed, after, avoid_uri))
        selected = records[start:start + size]
        revision = hashlib.sha256('\x00'.join(sorted(names)).encode('utf-8')).hexdigest()
        return {
            'records': selected,
            'seed': seed,
            'page': page,
            'total': total,
            'offset': start,
            'next_after': selected[-1]['name'] if selected else after,
            'has_more': start + len(selected) < total,
            'revision': revision,
            'resume_found': resume_found,
        }
