"""Runtime management of media sources (the folders the library scans).

Sources are edited through authenticated JSON endpoints, persisted into the
instance ``config.yaml`` so they survive restarts, and applied immediately by
swapping the shared LibraryService registry and rescanning the index.
"""

import sqlite3
from pathlib import Path

from flask import request

from spooly.services.config_store import MediaSourceConfigStore
from spooly.services.library import (
    MediaSource,
    normalize_exclusions,
    normalize_private_folders,
    normalize_source_id,
)

MAX_NAME_LENGTH = 80


def register_media_source_routes(
    app, *, library_service, library_indexer, media_index,
    config_store: MediaSourceConfigStore | None = None, system_collections=None,
):
    config_store = config_store or MediaSourceConfigStore()

    def _payload() -> dict:
        payload = request.get_json(silent=True) if request.get_data() else {}
        if not isinstance(payload, dict):
            raise ValueError('请求体必须是 JSON 对象。')
        return payload

    def _validated_path(raw, existing: list[MediaSource], skip_id: str = '') -> Path:
        text = str(raw or '').strip()
        if not text:
            raise ValueError('文件夹路径不能为空。')
        path = Path(text).expanduser()
        if not path.is_absolute():
            raise ValueError(f'文件夹路径必须是绝对路径：{text}')
        resolved = path.resolve()
        try:
            if not resolved.exists():
                raise ValueError(f'路径不存在：{text}')
            if not resolved.is_dir():
                raise ValueError(f'路径不是文件夹：{text}')
        except OSError as error:
            raise ValueError(f'路径无法访问：{text}（{error}）') from error
        for source in existing:
            if source.id == skip_id:
                continue
            if (
                resolved == source.path
                or resolved in source.path.parents
                or source.path in resolved.parents
            ):
                raise ValueError(f'该路径与已有文件夹「{source.name}」互相嵌套，请换一个目录。')
        return resolved

    def _validated_name(raw, fallback: str) -> str:
        name = str(raw or '').strip()
        if not name:
            name = fallback
        if not name:
            raise ValueError('显示名称不能为空。')
        return name[:MAX_NAME_LENGTH]

    def _validated_exclude(raw) -> tuple:
        if raw is None:
            return ()
        return normalize_exclusions(raw, field='exclude')

    def _new_source_id(base: str, existing: list[MediaSource]) -> str:
        candidate = normalize_source_id(base) or 'source'
        used = {source.id for source in existing}
        if candidate not in used:
            return candidate
        suffix = 2
        while f'{candidate}-{suffix}' in used:
            suffix += 1
        return f'{candidate}-{suffix}'

    def _apply(sources: list[MediaSource]) -> dict:
        """Persist, hot-swap and rescan as one mutation under the indexer lock."""
        with library_indexer.mutation_lock:
            config_store.save_sources([
                {
                    'id': source.id,
                    'name': source.name,
                    'path': str(source.path),
                    'exclude': list(source.exclude),
                }
                for source in sources
            ])
            library_service.set_sources(sources)
            result = library_indexer.sync()
        return result

    def _serialize(source: MediaSource, counts: dict, unavailable: set) -> dict:
        try:
            exists = source.path.is_dir()
        except OSError:
            exists = False
        return {
            'id': source.id,
            'name': source.name,
            'path': str(source.path),
            'exclude': list(source.exclude),
            'exists': exists,
            'media_count': int(counts.get(source.id, 0)),
            'unavailable': source.id in unavailable,
        }

    def _list_payload(unavailable=()) -> dict:
        counts = media_index.count_by_source()
        unavailable = set(unavailable)
        return {
            'items': [_serialize(source, counts, unavailable) for source in library_service.sources],
        }

    @app.get('/api/media-sources')
    def api_media_sources():
        return {'success': True, 'data': _list_payload()}

    @app.post('/api/media-sources')
    def api_media_source_create():
        try:
            payload = _payload()
            if set(payload) - {'path', 'name', 'exclude', '_csrf_token'}:
                raise ValueError('仅支持 path、name、exclude 字段。')
            if 'path' not in payload:
                raise ValueError('缺少 path 字段。')
            existing = list(library_service.sources)
            resolved = _validated_path(payload.get('path'), existing)
            name = _validated_name(payload.get('name'), resolved.name)
            source = MediaSource(
                id=_new_source_id(name or resolved.name, existing),
                name=name,
                path=resolved,
                exclude=_validated_exclude(payload.get('exclude')),
            )
            result = _apply([*existing, source])
        except ValueError as error:
            return {'success': False, 'error': str(error)}, 400
        except (OSError, sqlite3.Error):
            return {'success': False, 'error': '文件夹保存失败，请稍后重试。'}, 503
        return {'success': True, 'data': {**_list_payload(result.get('unavailable_sources', [])), 'index': result}}

    @app.patch('/api/media-sources/<string:source_id>')
    def api_media_source_update(source_id):
        try:
            payload = _payload()
            if set(payload) - {'path', 'name', 'exclude', '_csrf_token'}:
                raise ValueError('仅支持 path、name、exclude 字段。')
            if not set(payload) - {'_csrf_token'}:
                raise ValueError('没有需要修改的字段。')
            existing = list(library_service.sources)
            target = library_service.sources_by_id.get(source_id)
            if target is None:
                return {'success': False, 'error': '未找到该文件夹。'}, 404
            resolved = (
                _validated_path(payload['path'], existing, skip_id=source_id)
                if 'path' in payload else target.path
            )
            name = _validated_name(payload['name'], target.name) if 'name' in payload else target.name
            exclude = _validated_exclude(payload['exclude']) if 'exclude' in payload else target.exclude
            updated = MediaSource(id=target.id, name=name, path=resolved, exclude=exclude)
            result = _apply([
                updated if source.id == source_id else source for source in existing
            ])
        except ValueError as error:
            return {'success': False, 'error': str(error)}, 400
        except (OSError, sqlite3.Error):
            return {'success': False, 'error': '文件夹保存失败，请稍后重试。'}, 503
        return {'success': True, 'data': {**_list_payload(result.get('unavailable_sources', [])), 'index': result}}

    def _private_entry(uri: str) -> dict:
        source_text, _, rel = uri[1:].partition('/')
        source = library_service.sources_by_id.get(source_text)
        return {
            'uri': uri,
            'name': rel.rsplit('/', 1)[-1] if rel else (source.name if source else source_text),
            'source_id': source_text,
            'is_source': not rel,
        }

    @app.get('/api/private-folders')
    def api_private_folders():
        return {
            'success': True,
            'data': {'items': [_private_entry(uri) for uri in library_service.private_folders]},
        }

    @app.put('/api/private-folders')
    def api_private_folders_update():
        """Replace the private folder markers; no rescan, applies immediately."""
        try:
            payload = _payload()
            if set(payload) - {'folders', '_csrf_token'}:
                raise ValueError('仅支持 folders 字段。')
            if 'folders' not in payload:
                raise ValueError('缺少 folders 字段。')
            folders = normalize_private_folders(payload.get('folders'))
            config_store.save_private_folders(list(folders))
            library_service.set_private_folders(folders)
            media_index.set_private_prefixes(tuple(folders))
            if system_collections is not None:
                # Privatized media leaves the managed collections immediately.
                system_collections.reconcile('liked')
                system_collections.reconcile('favorited')
        except ValueError as error:
            return {'success': False, 'error': str(error)}, 400
        except (OSError, sqlite3.Error):
            return {'success': False, 'error': '隐私文件夹保存失败，请稍后重试。'}, 503
        return {
            'success': True,
            'data': {'items': [_private_entry(uri) for uri in folders]},
        }

    @app.delete('/api/media-sources/<string:source_id>')
    def api_media_source_delete(source_id):
        try:
            existing = list(library_service.sources)
            if source_id not in library_service.sources_by_id:
                return {'success': False, 'error': '未找到该文件夹。'}, 404
            if len(existing) <= 1:
                raise ValueError('至少需要保留一个文件夹，无法删除最后一个。')
            remaining = [source for source in existing if source.id != source_id]
            with library_indexer.mutation_lock:
                media_index.purge_source(source_id)
                result = _apply(remaining)
        except ValueError as error:
            return {'success': False, 'error': str(error)}, 400
        except (OSError, sqlite3.Error):
            return {'success': False, 'error': '文件夹删除失败，请稍后重试。'}, 503
        return {'success': True, 'data': {**_list_payload(result.get('unavailable_sources', [])), 'index': result}}
