"""Index-backed folder browsing and deterministic, bounded media feeds.

Directory listings contain indexed video/image parents, their ancestors and the
configured source roots. They never enumerate the filesystem. A directly
requested, existing empty directory is accepted, but is not listed proactively.
"""

from contextlib import closing
from dataclasses import dataclass
import hashlib
from pathlib import Path, PureWindowsPath
import secrets
import sqlite3

from spooly.services.library import LibraryService
from spooly.services.library_index import MediaIndexStore
from spooly.services.trash import TRASH_DIR


class BrowseError(ValueError):
    """A public browsing error whose message contains no host filesystem path."""

    def __init__(self, message: str, status: int = 400):
        super().__init__(message)
        self.status = status


@dataclass(frozen=True)
class FolderRef:
    source_id: str
    path: str

    @property
    def uri(self) -> str:
        return f"@{self.source_id}/{self.path}"


class BrowseService:
    def __init__(self, library_service: LibraryService, media_index: MediaIndexStore):
        self.library = library_service
        self.database = media_index.database

    @staticmethod
    def _relative_path(value: str) -> str:
        # Backslashes inside a POSIX filename remain literal. Check Windows
        # traversal spellings too, without converting them into separators.
        if (
            '\x00' in value
            or value.startswith(('/', '\\'))
            or PureWindowsPath(value).drive
            or '..' in value.replace('\\', '/').split('/')
        ):
            raise BrowseError('folder must be a source-relative directory.')
        return '/'.join(part for part in value.split('/') if part not in {'', '.'})

    def parse_folder(self, value: str | None) -> FolderRef | None:
        if value is None:
            return None
        if not value or '\x00' in value:
            raise BrowseError('folder cannot be empty or contain NUL.')
        if value.startswith('@'):
            source_id, separator, relative = value[1:].partition('/')
            if not separator or not source_id:
                raise BrowseError('folder must include a source and a slash, such as @source/.')
        else:
            source_id, relative = self.library.default_source_id, value
        if source_id not in self.library.sources_by_id:
            raise BrowseError('Media source not found.', 404)
        folder = FolderRef(source_id, self._relative_path(relative))
        if TRASH_DIR in folder.path.split('/') or (
            folder.path and self.library.is_excluded(folder.uri, is_dir=True)
        ):
            raise BrowseError('Folder not found.', 404)
        if self._resolved_path(folder.source_id, folder.path) is None:
            raise BrowseError('folder must stay within its media source.')
        return folder

    def _resolved_path(self, source_id: str, relative: str) -> Path | None:
        source = self.library.sources_by_id.get(source_id)
        if source is None:
            return None
        try:
            root = source.path.resolve()
            target = (root / relative).resolve()
            target.relative_to(root)
        except (OSError, RuntimeError, ValueError):
            return None
        return target

    def _visible(self, row: sqlite3.Row) -> bool:
        source_id, relative, uri = str(row['source_id']), str(row['rel_path']), str(row['uri'])
        if source_id not in self.library.sources_by_id or not relative:
            return False
        try:
            if self._relative_path(relative) != relative:
                return False
        except BrowseError:
            return False
        if uri != f"@{source_id}/{relative}" or TRASH_DIR in relative.split('/'):
            return False
        # Apply current rules even to cached rows belonging to offline sources.
        if self.library.is_excluded(uri):
            return False
        # Missing files stay queryable, while a changed symlink cannot expose a
        # path outside its source. resolve(strict=False) does not require media.
        return self._resolved_path(source_id, relative) is not None

    def _rows(
        self, conn: sqlite3.Connection, *, folder: FolderRef | None = None,
        filter_name: str = '', recursive: bool = True, hide_private: bool = False,
    ) -> list[sqlite3.Row]:
        clauses = ["m.media_type IN ('video', 'image')"]
        params: list[object] = []
        if folder is not None:
            clauses.append('m.source_id = ?')
            params.append(folder.source_id)
            if not recursive:
                clauses.append('m.parent_path = ?')
                params.append(folder.path or '.')
            elif folder.path:
                prefix = folder.path + '/'
                # substr equality is case sensitive and treats %, _ and \
                # literally, unlike a LIKE expression or an unescaped pattern.
                clauses.append('substr(m.rel_path, 1, ?) = ?')
                params.extend((len(prefix), prefix))
        if filter_name:
            field = {'liked': 'is_liked', 'favorited': 'is_favorited'}[filter_name]
            clauses.append(f'r.{field} = 1')
        order_by = {
            'liked': 'r.liked_at DESC, m.uri',
            'favorited': 'r.favorited_at DESC, m.uri',
        }.get(filter_name, 'm.source_id, m.rel_path, m.uri')
        rows = conn.execute(
            f"""
            SELECT m.*, COALESCE(r.is_liked, 0) AS is_liked, r.liked_at,
                   COALESCE(r.is_favorited, 0) AS is_favorited, r.favorited_at
            FROM media_items AS m
            LEFT JOIN media_reactions AS r ON r.uri = m.uri
            WHERE {' AND '.join(clauses)}
            ORDER BY {order_by}
            """,
            params,
        ).fetchall()
        if hide_private:
            return [
                row for row in rows
                if self._visible(row) and not self.library.is_private(str(row['uri']))
            ]
        return [row for row in rows if self._visible(row)]

    def _require_folder(
        self, conn: sqlite3.Connection, folder: FolderRef, rows: list[sqlite3.Row],
    ) -> None:
        # A known folder can have no matching reactions or direct media. Retain
        # its existence independently of feed filters and source availability.
        if not folder.path or rows:
            return
        prefix = folder.path + '/'
        indexed = conn.execute(
            """
            SELECT 1 FROM media_items
            WHERE source_id = ? AND media_type IN ('video', 'image')
              AND substr(rel_path, 1, ?) = ?
            LIMIT 1
            """,
            (folder.source_id, len(prefix), prefix),
        ).fetchone()
        if indexed:
            return
        target = self._resolved_path(folder.source_id, folder.path)
        try:
            exists = target is not None and target.is_dir()
        except OSError:
            exists = False
        if not exists:
            raise BrowseError('Folder not found.', 404)

    @staticmethod
    def _page(items: list, offset: int, limit: int) -> dict:
        total = len(items)
        return {
            'items': items[offset:offset + limit],
            'total': total,
            'offset': offset,
            'limit': limit,
            'next_offset': offset + limit,
            'has_more': offset + limit < total,
        }

    @staticmethod
    def _feed_record(row: sqlite3.Row) -> dict:
        return {
            **MediaIndexStore._to_library_record(row),
            'id': str(row['uri']),
            'is_liked': bool(row['is_liked']),
            'liked_at': row['liked_at'],
            'is_favorited': bool(row['is_favorited']),
            'favorited_at': row['favorited_at'],
        }

    def feed(
        self, *, folder: FolderRef | None = None, recursive: bool = True,
        order: str = 'sequential', filter_name: str = '', offset: int = 0,
        limit: int = 24, seed: str = '',
    ) -> dict:
        seed = seed or (secrets.token_hex(16) if order == 'random' else '')
        # Aggregate feeds (and scoped feeds outside a private folder) never show
        # private media; a feed scoped inside a private folder plays it locally.
        hide_private = folder is None or not self.library.is_private(folder.uri)
        with closing(self.database.connect()) as conn, conn:
            conn.execute('BEGIN')
            rows = self._rows(
                conn, folder=folder, filter_name=filter_name, recursive=recursive,
                hide_private=hide_private,
            )
            if folder is not None:
                self._require_folder(conn, folder, rows)
            if order == 'random':
                rows.sort(key=lambda row: (
                    hashlib.sha256((seed + '\x00' + str(row['uri'])).encode('utf-8')).digest(),
                    str(row['uri']),
                ))
            page = self._page(rows, offset, limit)
            page['items'] = [self._feed_record(row) for row in page['items']]
        return {
            **page,
            'folder': folder.uri if folder is not None else None,
            'recursive': recursive,
            'order': order,
            'filter': filter_name,
            'seed': seed,
        }

    def _node(self, source_id: str, path: str) -> dict:
        parent_path = path.rpartition('/')[0]
        return {
            'uri': FolderRef(source_id, path).uri,
            'source_id': source_id,
            'path': path,
            'is_private': self.library.is_private(FolderRef(source_id, path).uri),
            'name': path.rsplit('/', 1)[-1] if path else self.library.sources_by_id[source_id].name,
            'parent_uri': FolderRef(source_id, parent_path).uri if path else None,
            'media_count': 0,
            'video_count': 0,
            'image_count': 0,
            'direct_media_count': 0,
            'cover_uri': '',
            'has_children': False,
        }

    def folders(
        self, *, folder: FolderRef | None = None, offset: int = 0, limit: int = 24,
    ) -> dict:
        with closing(self.database.connect()) as conn, conn:
            conn.execute('BEGIN')
            rows = self._rows(conn)
            nodes = {
                (source_id, ''): self._node(source_id, '')
                for source_id in self.library.sources_by_id
            }
            for row in rows:
                source_id = str(row['source_id'])
                parent_parts = str(row['rel_path']).split('/')[:-1]
                for depth in range(len(parent_parts) + 1):
                    path = '/'.join(parent_parts[:depth])
                    key = (source_id, path)
                    if key not in nodes:
                        nodes[key] = self._node(source_id, path)
                    node = nodes[key]
                    node['media_count'] += 1
                    node[str(row['media_type']) + '_count'] += 1
                    if not node['cover_uri']:
                        node['cover_uri'] = str(row['uri'])
                    if depth == len(parent_parts):
                        node['direct_media_count'] += 1
                    else:
                        node['has_children'] = True
            if folder is None:
                current = None
                items = [node for (_, path), node in nodes.items() if not path]
            else:
                current = nodes.get((folder.source_id, folder.path))
                if current is None:
                    self._require_folder(conn, folder, [])
                    current = self._node(folder.source_id, folder.path)
                items = [node for node in nodes.values() if node['parent_uri'] == folder.uri]
            items.sort(key=lambda node: (node['source_id'], node['path']))
            page = self._page(items, offset, limit)
        return {
            **page,
            # This is the parent of this page's children; current.parent_uri
            # separately identifies the requested directory's own parent.
            'parent': folder.uri if folder is not None else None,
            'current': current,
        }
