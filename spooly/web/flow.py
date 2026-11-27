"""Full-library random Flow and playback activity HTTP entry points."""

from flask import render_template, request

from spooly.services.browse import BrowseError, BrowseService
from spooly.services.reactions import MediaReactionStore
from spooly.services.shuffle import ShuffleService
from spooly.web import read_int_arg
from spooly.web.media_payloads import build_feed_media_item


def build_mix_feed_page(
    *, page: int, size: int, seed: str, recommend_service, media_index,
    download_source_store=None, activity_store=None, related_photo_groups=None,
    mode: str = '', after: str = '', resume_uri: str = '', avoid_uri: str = '',
) -> dict:
    """Retain the feed API while using one unbiased image/video permutation.

    Legacy recommendation/card inputs are accepted at this integration boundary
    so application registration stays compatible; they do not affect ordering.
    """
    result = ShuffleService(recommend_service.library, media_index).page(
        seed=seed, page=page, size=size, after=after, resume_uri=resume_uri,
        avoid_uri=avoid_uri,
    )
    records = result.pop('records')
    result['items'] = [
        {
            **build_feed_media_item(record['name'], record['media_type']),
            'recommendation_reason': '全库随机发现',
        }
        for record in records
    ]
    return result


def hydrate_mix_reactions(items: list[dict], reactions: MediaReactionStore) -> None:
    """Read reaction state in one batch without changing the random sequence."""
    states = reactions.get_many([item['name'] for item in items])
    for item in items:
        name = item['name']
        uri = name if name.startswith('@') else reactions.library.canonicalize_uri(name)
        state = states[uri]
        item.update({
            'id': state['uri'],
            **{key: state[key] for key in (
                'is_liked', 'liked_at', 'is_favorited', 'favorited_at',
            )},
        })


def register_flow_routes(
    app, *, media_index, recommend_service, download_source_store, activity_store,
    reactions: MediaReactionStore, related_photo_groups=None, collection_store=None,
    library_service=None,
):
    browse = BrowseService(library_service, media_index) if library_service else None

    @app.route('/flow')
    def flow_view():
        # ?collection=<id> opens collection playback; ?folder=@source/path plays
        # one folder (module H: the only scope where private media plays);
        # anything else is the full-library Flow.
        collection_id = str(request.args.get('collection', '')).strip()[:64]
        collection = None
        if collection_id and collection_store is not None:
            found = collection_store.get(collection_id)
            if found:
                collection = {
                    'id': found['id'],
                    'name': found['name'],
                    'item_count': found['item_count'],
                    'system': found.get('system', ''),
                }
        flow_folder = None
        folder_arg = str(request.args.get('folder', '')).strip()[:4096]
        if folder_arg and browse is not None and '\x00' not in folder_arg:
            try:
                folder = browse.parse_folder(folder_arg)
            except BrowseError:
                folder = None
            if folder is not None:
                source = library_service.sources_by_id[folder.source_id]
                flow_folder = {
                    'uri': folder.uri,
                    'name': folder.path.rsplit('/', 1)[-1] if folder.path else source.name,
                    'is_private': library_service.is_private(folder.uri),
                }
        return render_template(
            'flow.html', menu='flow', flow_filter='', flow_collection=collection,
            flow_folder=flow_folder,
        )

    @app.route('/api/feed/mix')
    def api_feed_mix():
        arguments = {key: request.args.get(key, '') for key in (
            'seed', 'after', 'resume_uri', 'avoid_uri',
        )}
        if len(arguments['seed']) > 512 or any('\x00' in value for value in arguments.values()):
            return {'error': '随机种子不能超过512个字符，参数不能包含空字符'}, 400
        if any(len(arguments[key]) > 4096 for key in ('after', 'resume_uri', 'avoid_uri')):
            return {'error': '媒体标识过长'}, 400
        result = build_mix_feed_page(
            page=read_int_arg('page', 1, minimum=1),
            size=read_int_arg('size', 24, minimum=1, maximum=200),
            recommend_service=recommend_service, media_index=media_index,
            **arguments,
        )
        hydrate_mix_reactions(result['items'], reactions)
        if request.args.get('snapshot') == '1':
            result['has_more'] = False
        return result

    @app.route('/api/activity', methods=['POST', 'DELETE'])
    def api_activity():
        if request.method == 'DELETE':
            activity_store.clear()
            return {'success': True}
        payload = request.get_json(silent=True) or {}
        events = payload.get('events') if isinstance(payload.get('events'), list) else [payload]
        accepted = activity_store.record_many(events)
        return {'success': True, 'data': {'accepted': accepted}}
