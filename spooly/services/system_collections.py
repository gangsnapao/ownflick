"""Mirror liked/favorited reactions into the two managed system collections.

``media_reactions`` is the single source of truth: the system collections are a
playback-friendly view of it. Every like/favorite mutation funnels through
MediaReactionStore, whose ``on_change`` hook calls into this syncer, so the
collections stay consistent no matter which UI or endpoint changed the state.
"""

from spooly.services.collections import MAX_COLLECTION_ITEMS_MUTATION

# kind -> (collection id, fixed display name)
SYSTEM_COLLECTIONS = {
    'liked': ('auto-liked', '我的点赞'),
    'favorited': ('auto-favorited', '我的收藏'),
}

REACTION_TO_KIND = {'like': 'liked', 'favorite': 'favorited'}


class SystemCollectionSync:
    def __init__(self, collection_store, reactions, *, private_filter=None):
        self.collection_store = collection_store
        self.reactions = reactions
        # Private media keeps its raw reactions but never mirrors into the
        # system collections (module H: privacy isolation, not encryption).
        self.private_filter = private_filter

    def ensure(self) -> None:
        """Create missing system collections and mirror the current reactions."""
        for kind, (collection_id, name) in SYSTEM_COLLECTIONS.items():
            if self.collection_store.get(collection_id) is None:
                self.collection_store.create(
                    name, '由点赞/收藏自动维护', collection_id=collection_id, system=kind,
                )
            self.reconcile(kind)

    def on_reaction_change(self, kind: str, uri: str | None, state: dict | None) -> None:
        """Reaction hook: mirror one change, or reconcile everything on bulk saves."""
        target = REACTION_TO_KIND.get(kind)
        if target is None:
            return
        if uri is None:
            self.reconcile(target)
            return
        flag = 'is_liked' if kind == 'like' else 'is_favorited'
        present = bool((state or {}).get(flag))
        if present and self._is_private(uri):
            return
        collection_id, _ = SYSTEM_COLLECTIONS[target]
        self._set_membership(collection_id, [uri], present)

    def reconcile(self, kind: str) -> None:
        """Make one system collection exactly match its reaction set."""
        collection_id, _ = SYSTEM_COLLECTIONS[kind]
        desired = self.reactions.liked() if kind == 'liked' else self.reactions.favorites()
        desired = {uri for uri in desired if not self._is_private(uri)}
        current = set(self.collection_store.list_item_uris(collection_id, newest_first=False))
        self._set_membership(collection_id, sorted(desired - current), True)
        self._set_membership(collection_id, sorted(current - desired), False)

    def _is_private(self, uri: str) -> bool:
        try:
            return bool(self.private_filter and self.private_filter(uri))
        except (TypeError, ValueError):
            return False

    def _set_membership(self, collection_id: str, uris: list[str], present: bool) -> None:
        step = MAX_COLLECTION_ITEMS_MUTATION
        for start in range(0, len(uris), step):
            chunk = uris[start:start + step]
            if present:
                self.collection_store.add_items(collection_id, chunk)
            else:
                self.collection_store.remove_items(collection_id, chunk)
