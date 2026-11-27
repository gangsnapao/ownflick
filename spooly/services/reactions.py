"""Transactional likes and favorites, independent of the media index."""

import datetime
import json
import sqlite3
from pathlib import Path

from spooly.services.database import AppDatabase
from spooly.services.library import LibraryService


FAVORITES_IMPORT = 'favorites_json_v1'


def _utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).isoformat()


class MediaReactionStore:
    def __init__(self, database: AppDatabase, library_service: LibraryService):
        self.database = database
        self.library = library_service

    def _uri(self, value: str) -> str:
        uri = self.library.canonicalize_uri(value)
        if not uri:
            raise ValueError('Media URI cannot be empty.')
        return uri

    @staticmethod
    def _state(uri: str, row=None) -> dict:
        return {
            'uri': uri,
            'is_liked': bool(row['is_liked']) if row else False,
            'liked_at': row['liked_at'] if row else None,
            'is_favorited': bool(row['is_favorited']) if row else False,
            'favorited_at': row['favorited_at'] if row else None,
        }

    def import_favorites(self, path: Path) -> int:
        """Import the old array once, committing its marker with the imported state.

        The original file stays untouched. Historical favorite times were never
        stored, so every imported favorite receives this transaction's UTC time.
        Missing media and offline sources are deliberately retained.
        """
        with self.database.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if conn.execute(
                'SELECT 1 FROM data_migrations WHERE name = ?', (FAVORITES_IMPORT,),
            ).fetchone():
                return 0
            try:
                payload = json.loads(path.read_text(encoding='utf-8'))
            except FileNotFoundError:
                payload = []
            if not isinstance(payload, list) or any(
                not isinstance(item, str) or not item.strip() for item in payload
            ):
                raise ValueError('Invalid favorites file format; the original file has been preserved.')
            uris = sorted({self._uri(item) for item in payload})
            now = _utc_now()
            before = conn.total_changes
            conn.executemany(
                """
                INSERT INTO media_reactions(uri, is_favorited, favorited_at, updated_at)
                VALUES (?, 1, ?, ?)
                ON CONFLICT(uri) DO NOTHING
                """,
                [(uri, now, now) for uri in uris],
            )
            imported = conn.total_changes - before
            conn.execute(
                'INSERT INTO data_migrations(name, applied_at) VALUES (?, ?)',
                (FAVORITES_IMPORT, now),
            )
            return imported

    def get(self, uri: str) -> dict:
        uri = self._uri(uri)
        with self.database.connect() as conn:
            row = conn.execute('SELECT * FROM media_reactions WHERE uri = ?', (uri,)).fetchone()
        return self._state(uri, row)

    def get_many(self, uris: list[str]) -> dict[str, dict]:
        """Read indexed URIs and legacy names in one snapshot, with unset defaults.

        Qualified URIs already identify indexed files. Preserve their path bytes
        so legal whitespace or backslashes cannot alias another file's state.
        """
        unique = list(dict.fromkeys(
            uri if uri.startswith('@') else self._uri(uri) for uri in uris
        ))
        if not unique:
            return {}
        states = {uri: self._state(uri) for uri in unique}
        with self.database.connect() as conn:
            chunk_size = 500
            if hasattr(conn, 'getlimit'):
                chunk_size = min(chunk_size, conn.getlimit(sqlite3.SQLITE_LIMIT_VARIABLE_NUMBER))
            conn.execute('BEGIN')
            for start in range(0, len(unique), chunk_size):
                chunk = unique[start:start + chunk_size]
                placeholders = ','.join('?' for _ in chunk)
                rows = conn.execute(
                    f'SELECT * FROM media_reactions WHERE uri IN ({placeholders})', chunk,
                ).fetchall()
                states.update({str(row['uri']): self._state(str(row['uri']), row) for row in rows})
        return states

    def favorites(self) -> set[str]:
        with self.database.connect() as conn:
            rows = conn.execute('SELECT uri FROM media_reactions WHERE is_favorited = 1').fetchall()
        return {str(row['uri']) for row in rows}

    def liked(self) -> set[str]:
        with self.database.connect() as conn:
            rows = conn.execute('SELECT uri FROM media_reactions WHERE is_liked = 1').fetchall()
        return {str(row['uri']) for row in rows}

    def _notify(self, kind: str, uri: str | None = None, state: dict | None = None) -> None:
        """Tell the reaction listener (system collections) about a committed change."""
        callback = getattr(self, 'on_change', None)
        if callback is not None:
            callback(kind, uri, state)

    def set_like(self, uri: str, state: bool | None = None) -> dict:
        return self._update(uri, 'like', state)

    def set_favorite(self, uri: str, state: bool | None = None) -> dict:
        return self._update(uri, 'favorite', state)

    def _update(self, uri: str, kind: str, state: bool | None) -> dict:
        uri = self._uri(uri)
        if state is not None and not isinstance(state, bool):
            raise ValueError('State must be a boolean.')
        flag, timestamp = {
            'like': ('is_liked', 'liked_at'),
            'favorite': ('is_favorited', 'favorited_at'),
        }[kind]
        with self.database.connect() as conn:
            # Read-modify-write is serialized across threads and processes.
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT * FROM media_reactions WHERE uri = ?', (uri,)).fetchone()
            before = bool(row[flag]) if row else False
            after = not before if state is None else state
            now = _utc_now()
            if row is None:
                conn.execute('INSERT INTO media_reactions(uri, updated_at) VALUES (?, ?)', (uri, now))
            if before != after:
                conn.execute(
                    f'UPDATE media_reactions SET {flag} = ?, {timestamp} = ?, updated_at = ? WHERE uri = ?',
                    (int(after), now if after else None, now, uri),
                )
            row = conn.execute('SELECT * FROM media_reactions WHERE uri = ?', (uri,)).fetchone()
        state = self._state(uri, row)
        if before != after:
            self._notify(kind, uri, state)
        return state

    def replace_favorites(self, favorites: set[str]) -> None:
        """Retain the legacy bulk-save API without resetting likes or timestamps."""
        uris = {self._uri(uri) for uri in favorites}
        with self.database.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            current = {
                str(row['uri']) for row in conn.execute(
                    'SELECT uri FROM media_reactions WHERE is_favorited = 1',
                ).fetchall()
            }
            now = _utc_now()
            conn.executemany(
                'UPDATE media_reactions SET is_favorited = 0, favorited_at = NULL, updated_at = ? WHERE uri = ?',
                [(now, uri) for uri in current - uris],
            )
            conn.executemany(
                """
                INSERT INTO media_reactions(uri, is_favorited, favorited_at, updated_at)
                VALUES (?, 1, ?, ?)
                ON CONFLICT(uri) DO UPDATE SET
                  is_favorited = 1, favorited_at = excluded.favorited_at, updated_at = excluded.updated_at
                """,
                [(uri, now, now) for uri in uris - current],
            )
        self._notify('favorite')
