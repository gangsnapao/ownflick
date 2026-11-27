"""Persist runtime-managed settings into the instance ``config.yaml``.

Only the keys a feature owns are rewritten; every other configuration key is
read before writing and preserved verbatim. The file written here is the same
one ``spooly.run.load_config`` reads first (instance directory wins).
"""

import os
import tempfile
from pathlib import Path
from typing import Any


def resolve_config_path() -> Path:
    """Return the highest-priority config file that ``load_config`` would read."""
    instance = os.environ.get('SPOOLY_INSTANCE')
    if instance:
        return Path(instance).expanduser() / 'config.yaml'
    global_path = Path.home() / '.config' / 'spooly' / 'config.yaml'
    legacy_path = Path.home() / '.spooly' / 'config.yaml'
    if global_path.exists() or not legacy_path.exists():
        return global_path
    return legacy_path


class MediaSourceConfigStore:
    """Read-merge-write the ``media_sources`` key of the instance config."""

    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path else resolve_config_path()

    def read(self) -> dict[str, Any]:
        if not self.path.exists():
            return {}
        import yaml

        with self.path.open('r', encoding='utf-8') as handle:
            payload = yaml.safe_load(handle) or {}
        if not isinstance(payload, dict):
            raise ValueError(f'配置文件 {self.path} 根节点必须是键值对象。')
        return payload

    def save_sources(self, sources: list[dict[str, Any]]) -> None:
        """Replace ``media_sources`` atomically, keeping all other keys intact."""
        self._save_key('media_sources', sources)

    def save_private_folders(self, folders: list[str]) -> None:
        """Replace ``private_folders`` atomically, keeping all other keys intact."""
        self._save_key('private_folders', folders)

    def _save_key(self, key: str, value: Any) -> None:
        import yaml

        payload = self.read()
        payload[key] = value
        self.path.parent.mkdir(parents=True, exist_ok=True)
        fd, temp_name = tempfile.mkstemp(
            dir=str(self.path.parent), prefix=self.path.name, suffix='.tmp',
        )
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as handle:
                yaml.safe_dump(payload, handle, allow_unicode=True, sort_keys=False)
            os.replace(temp_name, self.path)
        except BaseException:
            try:
                os.unlink(temp_name)
            except OSError:
                pass
            raise
