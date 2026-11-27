"""Import browser-selected media without replacing existing library files."""

import errno
import logging
import os
import shutil
import tempfile
import unicodedata
from pathlib import Path

from werkzeug.datastructures import FileStorage

from spooly.services.library import IMAGE_EXTENSIONS, VIDEO_EXTENSIONS


logger = logging.getLogger(__name__)
IMPORT_EXTENSIONS = IMAGE_EXTENSIONS | VIDEO_EXTENSIONS
COPY_CHUNK_BYTES = 1024 * 1024


class MediaImportError(ValueError):
    """A user-facing import failure with a Chinese explanation."""


def sanitize_media_filename(value: str) -> str:
    """Discard client paths and unsafe characters while preserving Chinese names."""
    name = unicodedata.normalize('NFC', str(value or '').replace('\\', '/').rsplit('/', 1)[-1])
    name = ''.join(
        '_' if character in '<>:"|?*' else character
        for character in name
        if not unicodedata.category(character).startswith('C')
    ).strip(' .')
    if not name:
        raise MediaImportError('文件名不能为空。')
    suffix = Path(name).suffix
    if suffix.lower() not in IMPORT_EXTENSIONS:
        raise MediaImportError('仅支持导入图片和视频文件。')
    stem = name[:-len(suffix)].strip(' .')
    if not stem:
        raise MediaImportError('文件名不能为空。')
    # Leave room for collision suffixes and filesystems with a 255-byte limit.
    while len(stem.encode('utf-8')) > 180:
        stem = stem[:-1]
    reserved = {'CON', 'PRN', 'AUX', 'NUL'} | {
        f'{prefix}{number}' for prefix in ('COM', 'LPT') for number in range(1, 10)
    }
    if stem.split('.')[0].upper() in reserved:
        stem = '_' + stem
    return stem + suffix


def _storage_error(error: OSError) -> str:
    if isinstance(error, PermissionError) or error.errno in {errno.EACCES, errno.EPERM, errno.EROFS}:
        return '媒体目录不可写，请检查目录权限。'
    if error.errno in {errno.ENOSPC, errno.EDQUOT}:
        return '存储空间不足，请清理磁盘后重试。'
    return '文件保存失败，请检查媒体目录后重试。'


class MediaImportService:
    """Store and register each upload independently, cleaning failed imports."""

    def __init__(self, library_service, library_indexer, media_index, *, max_file_bytes: int):
        self.library = library_service
        self.indexer = library_indexer
        self.media_index = media_index
        self.max_file_bytes = max_file_bytes

    def import_file(self, upload: FileStorage) -> dict:
        # Keep incomplete NAS copies and failed registrations out of scans until
        # publication or rollback is finished. register_uris re-enters this lock.
        with self.indexer.mutation_lock:
            return self._import_file(upload)

    def _import_file(self, upload: FileStorage) -> dict:
        original_name = str(upload.filename or '')
        temporary = None
        destination = None
        uri = ''
        indexed = False
        try:
            name = sanitize_media_filename(original_name)
            root = self.library.media_root
            if not root.is_dir():
                raise MediaImportError('媒体目录不可用，请检查目录是否存在或已挂载。')
            with tempfile.NamedTemporaryFile(
                mode='wb', prefix='.ownflick-import-', suffix='.part', dir=root, delete=False,
            ) as target:
                temporary = Path(target.name)
                size = 0
                while chunk := upload.stream.read(COPY_CHUNK_BYTES):
                    size += len(chunk)
                    if size > self.max_file_bytes:
                        raise MediaImportError('文件超过单个文件的导入大小限制。')
                    target.write(chunk)
            if size == 0:
                raise MediaImportError('空文件无法导入。')
            # Hard-linking within the same directory publishes the complete file
            # atomically. Unlike replace/rename, it cannot overwrite a race winner
            # or follow a pre-existing destination symlink.
            for number in range(10000):
                candidate_name = name if number == 0 else f'{Path(name).stem} ({number}){Path(name).suffix}'
                candidate = root / candidate_name
                candidate_uri = self.library.get_relative_path(candidate)
                if self.library.is_excluded(candidate_uri):
                    raise MediaImportError('该文件名被媒体库排除规则忽略，请更改文件名后重试。')
                try:
                    os.link(temporary, candidate)
                except FileExistsError:
                    continue
                except OSError as error:
                    # Some NAS mounts reject hard links (EXDEV/EOPNOTSUPP/etc.).
                    # The shared mutation lock hides the exclusive copy from scans;
                    # xb still prevents overwriting a race winner or symlink.
                    unsupported_link_errors = {
                        errno.EXDEV, errno.EPERM, errno.EOPNOTSUPP,
                        getattr(errno, 'ENOTSUP', errno.EOPNOTSUPP),
                        getattr(errno, 'ENOSYS', errno.EOPNOTSUPP),
                        getattr(errno, 'EINVAL', errno.EOPNOTSUPP),
                    }
                    if error.errno not in unsupported_link_errors:
                        raise
                    try:
                        output = candidate.open('xb')
                    except FileExistsError:
                        continue
                    # Track ownership before copying so any failure uses the
                    # same file/index rollback as registration errors.
                    destination, uri = candidate, candidate_uri
                    with output, temporary.open('rb') as source:
                        shutil.copyfileobj(source, output, COPY_CHUNK_BYTES)
                        output.flush()
                        os.fsync(output.fileno())
                destination, uri = candidate, candidate_uri
                break
            else:
                raise MediaImportError('同名文件过多，请更改文件名后重试。')
            temporary.unlink()
            temporary = None
            try:
                count = self.indexer.register_uris([uri])
                if count != 1:
                    raise ValueError('The imported file was not registered.')
                indexed = True
            except Exception as error:
                raise MediaImportError('文件建立索引失败，请重新导入。') from error
            return {
                'original_name': original_name, 'success': True,
                'name': destination.name, 'uri': uri, 'size_bytes': size,
                'message': '导入成功',
            }
        except MediaImportError as error:
            message = str(error)
        except OSError as error:
            message = _storage_error(error)
        except Exception:
            logger.exception('Unexpected media import failure')
            message = '文件导入失败，请重试。'
        finally:
            if not indexed and destination is not None:
                try:
                    self.media_index.delete(uri)
                except Exception:
                    logger.exception('Could not remove a failed import from the media index')
                try:
                    destination.unlink(missing_ok=True)
                except OSError:
                    logger.exception('Could not remove a failed imported media file')
            if temporary is not None:
                try:
                    temporary.unlink(missing_ok=True)
                except OSError:
                    logger.exception('Could not remove a temporary media import')
        return {'original_name': original_name, 'success': False, 'error': message}
