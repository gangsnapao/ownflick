"""Like and favorite mutations for indexed media."""

import sqlite3
from pathlib import PureWindowsPath

from flask import request

from spooly.services.library import LibraryService, normalize_media_uri
from spooly.services.library_index import MediaIndexStore
from spooly.services.reactions import MediaReactionStore


def register_reaction_routes(
    app, *, library_service: LibraryService, media_index: MediaIndexStore,
    reactions: MediaReactionStore,
):
    def media_uri(name: str) -> str:
        clean = normalize_media_uri(name)
        relative = clean
        if clean.startswith('@'):
            source_id, separator, relative = clean[1:].partition('/')
            if source_id not in library_service.sources_by_id:
                raise LookupError('Media source not found.')
            if not separator:
                raise ValueError('A media path is required.')
        if (
            not relative or '\x00' in relative or relative.startswith('/')
            or PureWindowsPath(relative).drive or '..' in relative.split('/')
        ):
            raise ValueError('Invalid media path.')
        uri = library_service.canonicalize_uri(clean)
        if library_service.resolve_path(uri) is None:
            raise ValueError('Invalid media path.')
        if library_service.is_excluded(uri):
            raise LookupError('Media not found.')
        with media_index.database.connect() as conn:
            found = conn.execute('SELECT 1 FROM media_items WHERE uri = ?', (uri,)).fetchone()
        if not found:
            raise LookupError('Media not found.')
        return uri

    def update(name: str, kind: str):
        payload = request.get_json(silent=True) if request.get_data() else {}
        if not isinstance(payload, dict) or set(payload) - {'state', '_csrf_token'}:
            return {'success': False, 'error': 'Expected a JSON object with an optional boolean state.'}, 400
        if 'state' in payload and not isinstance(payload['state'], bool):
            return {'success': False, 'error': 'state must be a boolean.'}, 400
        try:
            uri = media_uri(name)
            mutate = reactions.set_like if kind == 'like' else reactions.set_favorite
            state = mutate(uri, payload.get('state'))
        except ValueError as exc:
            return {'success': False, 'error': str(exc)}, 400
        except LookupError as exc:
            return {'success': False, 'error': str(exc)}, 404
        except (OSError, sqlite3.Error):
            return {'success': False, 'error': 'Media state could not be saved. Please try again later.'}, 503
        return {'success': True, 'data': {'id': uri, **state}}

    @app.post('/api/media/<path:name>/like')
    def api_media_like(name):
        return update(name, 'like')

    @app.post('/api/media/<path:name>/favorite')
    def api_media_favorite(name):
        return update(name, 'favorite')
