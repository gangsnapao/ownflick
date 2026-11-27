"""Folder hierarchy and scoped feeds share the same indexed browsing service."""

from flask import render_template, request

from spooly.services.browse import BrowseError, BrowseService
from spooly.web.media_payloads import media_urls, serialize_library_item


def _integer_arg(
    name: str, default: int, *, minimum: int, maximum: int | None = None,
) -> int:
    raw = request.args.get(name)
    if raw is None:
        return default
    if not raw.isascii() or not raw.isdecimal():
        raise BrowseError(f'{name} must be an integer.')
    try:
        value = int(raw)
    except ValueError:
        raise BrowseError(f'{name} must be an integer.') from None
    if value < minimum or (maximum is not None and value > maximum):
        raise BrowseError(f'{name} is outside its allowed range.')
    return value


def _pagination() -> dict:
    return {
        'offset': _integer_arg('offset', 0, minimum=0),
        'limit': _integer_arg('limit', 24, minimum=1, maximum=96),
    }


def _folder_node(node: dict | None) -> dict | None:
    if node is None:
        return None
    cover = node['cover_uri']
    return {**node, 'thumb_url': media_urls(cover)['thumb_url'] if cover else ''}


def _feed_item(record: dict) -> dict:
    return {
        **serialize_library_item(record),
        **{key: record[key] for key in (
            'id', 'is_liked', 'liked_at', 'is_favorited', 'favorited_at',
        )},
    }


def register_browse_routes(app, *, library_service, media_index, reactions, activity_store):
    """Register read APIs; joined reactions and media use one SQLite snapshot.

    The reaction/activity service arguments keep the app integration boundary
    explicit. Reading joined state here avoids an extra connection per item.
    """
    browse = BrowseService(library_service, media_index)

    @app.get('/folders')
    def folders_view():
        return render_template('folders.html', menu='folder')

    @app.get('/api/folders')
    def api_folders():
        try:
            page = browse.folders(
                folder=browse.parse_folder(request.args.get('folder')),
                **_pagination(),
            )
        except BrowseError as error:
            return {'success': False, 'error': str(error)}, error.status
        page['current'] = _folder_node(page['current'])
        page['items'] = [_folder_node(node) for node in page['items']]
        return {'success': True, 'data': page}

    @app.get('/api/feed')
    def api_feed():
        try:
            recursive = request.args.get('recursive', 'true')
            if recursive not in {'true', 'false'}:
                raise BrowseError('recursive must be true or false.')
            order = request.args.get('order', 'sequential')
            if order not in {'sequential', 'random'}:
                raise BrowseError('order must be sequential or random.')
            filter_name = request.args.get('filter', '')
            if filter_name not in {'', 'liked', 'favorited'}:
                raise BrowseError('filter must be liked or favorited.')
            seed = request.args.get('seed', '')
            if len(seed) > 512 or '\x00' in seed:
                raise BrowseError('seed must contain at most 512 characters and no NUL.')
            page = browse.feed(
                folder=browse.parse_folder(request.args.get('folder')),
                recursive=recursive == 'true', order=order,
                filter_name=filter_name, seed=seed, **_pagination(),
            )
        except BrowseError as error:
            return {'success': False, 'error': str(error)}, error.status
        page['items'] = [_feed_item(record) for record in page['items']]
        return {'success': True, 'data': page}
