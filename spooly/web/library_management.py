"""Browser media imports; existing library and media routes remain reusable."""

from flask import request
from werkzeug.exceptions import BadRequest, RequestEntityTooLarge

from spooly.services.media_import import MediaImportService


DEFAULT_IMPORT_LIMITS = {
    'LIBRARY_IMPORT_MAX_FILES': 50,
    'LIBRARY_IMPORT_MAX_FILE_BYTES': 512 * 1024 * 1024,
    'LIBRARY_IMPORT_MAX_REQUEST_BYTES': 1024 * 1024 * 1024,
}


def register_library_management_routes(app, *, library_service, library_indexer, media_index):
    """Register multipart ``files`` imports protected by the app's auth/CSRF hooks.

    Every valid request returns HTTP 200 with per-file outcomes, including when
    every file fails. Malformed requests return 400; request/count limits return
    413. Only successfully stored and indexed files are reported as imported.
    """
    for key, default in DEFAULT_IMPORT_LIMITS.items():
        value = app.config.setdefault(key, default)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1:
            raise ValueError(f'{key} must be a positive integer')

    importer = MediaImportService(
        library_service, library_indexer, media_index,
        max_file_bytes=app.config['LIBRARY_IMPORT_MAX_FILE_BYTES'],
    )
    app.extensions['media_import'] = importer

    @app.url_value_preprocessor
    def limit_library_import(endpoint, values):
        # URL preprocessors precede auth's form/CSRF parsing, so limits also
        # apply to multipart bodies that contain a form-based CSRF token.
        if endpoint != 'api_library_import':
            return
        cap = app.config['LIBRARY_IMPORT_MAX_REQUEST_BYTES']
        if request.max_content_length is not None:
            cap = min(cap, request.max_content_length)
        request.max_content_length = cap
        request.max_form_parts = min(
            request.max_form_parts or 1000,
            app.config['LIBRARY_IMPORT_MAX_FILES'] + 4,
        )
        if request.content_length is not None and request.content_length > cap:
            raise RequestEntityTooLarge()

    @app.errorhandler(RequestEntityTooLarge)
    def library_import_too_large(error):
        if request.endpoint == 'api_library_import':
            return {'success': False, 'error': '导入请求过大或文件数量过多，请分批导入。'}, 413
        return error.get_response()

    @app.post('/api/library/import')
    def api_library_import():
        if request.mimetype != 'multipart/form-data':
            return {'success': False, 'error': '请使用文件表单选择图片或视频。'}, 400
        try:
            files = request.files.getlist('files')
        except BadRequest:
            return {'success': False, 'error': '文件表单无效，请重新选择文件。'}, 400
        if not files:
            return {'success': False, 'error': '请至少选择一个图片或视频文件。'}, 400
        if len(files) > app.config['LIBRARY_IMPORT_MAX_FILES']:
            return {'success': False, 'error': '一次导入的文件过多，请分批导入。'}, 413
        items = [importer.import_file(upload) for upload in files]
        imported = sum(item['success'] for item in items)
        return {
            'success': True,
            'data': {
                'total': len(items), 'imported': imported,
                'failed': len(items) - imported, 'items': items,
            },
        }
