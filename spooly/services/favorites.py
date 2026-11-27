"""Compatibility facade for the existing favorites consumers."""

from pathlib import Path

from spooly.services.database import AppDatabase
from spooly.services.library import LibraryService, normalize_media_uri
from spooly.services.reactions import MediaReactionStore


class FavoriteService:
    def __init__(
        self,
        db_path: Path,
        library_service: LibraryService,
        *,
        database: AppDatabase | None = None,
    ):
        self.db_path = db_path
        self.library_service = library_service
        if database is None:
            database = AppDatabase(db_path.with_name('spooly.sqlite3'))
            database.migrate()
        self.reactions = MediaReactionStore(database, library_service)
        self.reactions.import_favorites(db_path)

    def load(self) -> set[str]:
        return self.reactions.favorites()

    def save(self, favorites: set[str]) -> None:
        self.reactions.replace_favorites({item for item in favorites if normalize_media_uri(item)})

    def toggle(self, filename: str) -> bool:
        return self.reactions.set_favorite(filename)['is_favorited']

    def set_favorite(self, filename: str, is_favorite: bool) -> bool:
        return self.reactions.set_favorite(filename, bool(is_favorite))['is_favorited']

    def is_favorite(self, filename: str) -> bool:
        return self.reactions.get(filename)['is_favorited']
