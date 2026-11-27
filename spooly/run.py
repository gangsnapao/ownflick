import os
import sys
import signal
import argparse
import getpass
from pathlib import Path
from waitress import serve
from spooly.app import create_app
from spooly.thumbs import generate_thumbnails
from spooly.paths import get_data_dir
from spooly.paths import get_auth_path
from spooly.services.auth import AuthStore
from spooly.services.library import normalize_source_id
from spooly.config import normalize_media_sources, similarity_enabled

try:
    import yaml
except ImportError:
    yaml = None


def load_config():
    """Load configuration from a file."""
    config = {}

    # Try the supported configuration paths; an isolated instance reads its own first.
    config_paths = [
        Path.home() / '.config' / 'spooly' / 'config.yaml',
        Path.home() / '.spooly' / 'config.yaml',
    ]
    instance = os.environ.get('SPOOLY_INSTANCE')
    if instance:
        config_paths.insert(0, Path(instance).expanduser() / 'config.yaml')

    for config_path in config_paths:
        if config_path.exists():
            if yaml is None:
                print(f"警告：发现配置文件 {config_path}，但未安装 PyYAML，已跳过此文件", file=sys.stderr)
                break
            try:
                with open(config_path, 'r', encoding='utf-8') as f:
                    config = yaml.safe_load(f) or {}
                break
            except Exception as e:
                print(f"警告：读取配置文件 {config_path} 失败：{e}", file=sys.stderr)

    return config


def parse_cli_media_source(value):
    text = str(value or '').strip()
    if '=' not in text:
        raise argparse.ArgumentTypeError('格式必须为 id=/path/to/media')
    source_id, path = text.split('=', 1)
    source_id = normalize_source_id(source_id)
    path = path.strip()
    if not path:
        raise argparse.ArgumentTypeError('媒体目录不能为空')
    return {'id': source_id, 'name': source_id, 'path': path}


class ChineseHelpFormatter(argparse.RawDescriptionHelpFormatter):
    def add_usage(self, usage, actions, groups, prefix=None):
        super().add_usage(usage, actions, groups, prefix or '用法：')


class ChineseArgumentParser(argparse.ArgumentParser):
    def __init__(self, *args, **kwargs):
        add_help = kwargs.pop('add_help', True)
        kwargs.setdefault('formatter_class', ChineseHelpFormatter)
        super().__init__(*args, add_help=False, **kwargs)
        self._positionals.title = '位置参数'
        self._optionals.title = '选项'
        if add_help:
            self.add_argument('-h', '--help', action='help', help='显示此帮助信息并退出')

    def error(self, message):
        self.print_usage(sys.stderr)
        self.exit(2, f'{self.prog}: 错误：{message}\n')


def main():
    # Read the configuration file.
    config = load_config()

    # Normalize argv to support the following forms.
    # 1) ownflick                    -> serve
    # 2) ownflick /path              -> serve /path
    # 3) ownflick --port 9000        -> serve --port 9000
    # 4) ownflick thumbs /path       -> thumbs /path
    # 5) ownflick /path thumbs       -> thumbs /path
    argv = sys.argv[1:]
    if '-h' not in argv and '--help' not in argv:
        if 'thumbs' in argv:
            idx = argv.index('thumbs')
            if idx != 0:
                argv.pop(idx)
                argv.insert(0, 'thumbs')
        elif len(argv) == 0 or argv[0] not in ('serve', 'thumbs', 'dedupe', 'vectorize', 'auth'):
            # Default to serve when no known subcommand is present.
            argv.insert(0, 'serve')

    # Parse commands and options.
    parser = ChineseArgumentParser(
        description='OwnFlick — 本地媒体服务器',
        formatter_class=ChineseHelpFormatter,
        epilog='''
示例：
  ownflick                                # 启动服务器（默认）
  ownflick /path/to/media                 # 指定媒体目录
  ownflick --port 9000                    # 指定端口
  ownflick serve /path --port 9000        # 显式使用 serve 命令
  ownflick thumbs /path --overwrite       # 批量生成封面
  ownflick dedupe /path --dry-run         # 预览重复文件
  ownflick dedupe /path --execute         # 删除重复文件，保留最早的文件
  ownflick vectorize /path --limit 200    # 为 200 张图片或视频生成相似度向量
  ownflick auth set-password              # 设置新的访问密码
        '''
    )

    subparsers = parser.add_subparsers(dest='command', title='命令')

    # serve command
    serve_parser = subparsers.add_parser('serve', help='启动服务器')
    serve_parser.add_argument('media_root', nargs='?', help='媒体根目录')
    serve_parser.add_argument('--host', default=None, help='服务器监听地址（默认：0.0.0.0）')
    serve_parser.add_argument('--port', type=int, default=None, help='服务器端口（默认：8000）')
    serve_parser.add_argument('--dev', action='store_true', help='启用开发模式的自动重载和调试')
    serve_parser.add_argument('--name', default=None, help='此实例的显示名称')
    serve_parser.add_argument('--media-source', action='append', type=parse_cli_media_source,
                              help='添加媒体源，格式为 id=/path/to/media，可重复指定')
    serve_parser.add_argument('--download-source', default=None, help=argparse.SUPPRESS)

    auth_parser = subparsers.add_parser('auth', help='管理访问认证')
    auth_parser.add_argument('action', choices=['set-password', 'status'], help='认证操作')

    # thumbs command
    thumbs_parser = subparsers.add_parser('thumbs', help='批量生成视频封面')
    thumbs_parser.add_argument('media_root', nargs='?', help='媒体根目录（已在其他位置配置时可省略）')
    thumbs_parser.add_argument('--overwrite', action='store_true', help='重新生成已有封面')
    thumbs_parser.add_argument('--limit', type=int, default=0, help='最多处理数量（0 表示全部）')

    # dedupe command
    dedupe_parser = subparsers.add_parser('dedupe', help='查找并清理重复文件')
    dedupe_parser.add_argument('media_root', nargs='?', help='媒体根目录')
    dedupe_parser.add_argument('--type', choices=['video', 'image', 'all'], default='all',
                              help='文件类型（默认：all，即全部）')
    dedupe_parser.add_argument('--algorithm', choices=['md5', 'sha256'], default='sha256',
                              help='哈希算法（默认：sha256）')
    dedupe_parser.add_argument('--keep', choices=['oldest', 'newest', 'shortest_path'], default='oldest',
                              help='保留策略：oldest 为最早，newest 为最新，shortest_path 为最短路径（默认：oldest）')
    dedupe_parser.add_argument('--dry-run', action='store_true', default=True,
                              help='预览将删除的文件（默认）')
    dedupe_parser.add_argument('--execute', action='store_true',
                              help='执行删除，而非仅预览')
    dedupe_parser.add_argument('--auto-confirm', action='store_true',
                              help='跳过删除确认提示')

    # vectorize command
    vectorize_parser = subparsers.add_parser('vectorize', help='生成图片与视频向量，用于相似度分析和搜索')
    vectorize_parser.add_argument('media_root', nargs='?', help='媒体根目录（已在其他位置配置时可省略）')
    vectorize_parser.add_argument('--media-source', action='append', type=parse_cli_media_source,
                                  help='添加媒体源，格式为 id=/path/to/media，可重复指定')
    vectorize_parser.add_argument('--limit', type=int, default=0, help='最多发送的文件数量（0 表示全部）')
    vectorize_parser.add_argument('--dry-run', action='store_true', help='显示执行计划，不调用模型')
    vectorize_parser.add_argument('--yes', action='store_true', help='跳过确认提示')

    args = parser.parse_args(argv)

    # Treat a missing subcommand as serve.
    cmd = args.command or 'serve'

    if cmd == 'thumbs':
        media_root = args.media_root or os.environ.get('MEDIA_ROOT') or config.get('media_root')
        if not media_root:
            parser.error('请指定媒体目录：\n  - ownflick thumbs /path/to/media\n  - 或设置 MEDIA_ROOT=/path/to/media')
        media_path = Path(media_root)
        if not media_path.exists() or not media_path.is_dir():
            print(f"错误：媒体目录不可用：{media_root}", file=sys.stderr)
            sys.exit(1)
        print(f"数据目录：{get_data_dir()}")
        stats = generate_thumbnails(media_path, overwrite=getattr(args, 'overwrite', False), limit=getattr(args, 'limit', 0), show_progress=True)
        # Exit after completion.
        return

    if cmd == 'dedupe':
        from spooly.dedupe import run_dedupe

        media_root = args.media_root or os.environ.get('MEDIA_ROOT') or config.get('media_root')
        if not media_root:
            parser.error('请指定媒体目录：\n  - ownflick dedupe /path/to/media\n  - 或设置 MEDIA_ROOT=/path/to/media')

        media_path = Path(media_root)
        if not media_path.exists() or not media_path.is_dir():
            print(f"错误：媒体目录不可用：{media_root}", file=sys.stderr)
            sys.exit(1)

        # --execute disables dry-run.
        dry_run = not getattr(args, 'execute', False)

        stats = run_dedupe(
            media_root=media_path,
            file_type=getattr(args, 'type', 'all'),
            algorithm=getattr(args, 'algorithm', 'sha256'),
            keep_strategy=getattr(args, 'keep', 'oldest'),
            dry_run=dry_run,
            auto_confirm=getattr(args, 'auto_confirm', False)
        )
        return

    if cmd == 'vectorize':
        try:
            enabled = similarity_enabled(config.get('experiments'), config.get('embedding') or config.get('embedding_config'))
        except ValueError as exc:
            parser.error(str(exc))
        if not enabled:
            parser.error('相似图片实验尚未启用；请设置 experiments.similarity.enabled: true')
        from spooly.experiments.similarity.cli import run_vectorize
        run_vectorize(config, args, parser)
        return

    if cmd == 'auth':
        auth_store = AuthStore(get_auth_path())
        if args.action == 'status':
            try:
                bootstrap = auth_store.ensure(os.environ.get('SPOOLY_AUTH_PASSWORD'))
            except ValueError as exc:
                parser.error(str(exc))
            print("访问认证：已启用")
            print(f"认证文件：{auth_store.path}")
            if bootstrap.generated_password:
                print(f"初始访问密码：{bootstrap.generated_password}")
            return

        env_password = str(os.environ.get('SPOOLY_AUTH_PASSWORD') or '')
        if env_password:
            password = env_password
        else:
            password = getpass.getpass('新访问密码：')
            confirmation = getpass.getpass('再次输入密码：')
            if password != confirmation:
                parser.error('两次输入的密码不一致')
        try:
            auth_store.set_password(password)
        except ValueError as exc:
            parser.error(str(exc))
        print('访问密码已更新，所有已登录设备都需要重新登录。')
        return

    # Serve path.
    media_root = args.media_root or os.environ.get('MEDIA_ROOT') or config.get('media_root')
    host = args.host or os.environ.get('SPOOLY_HOST') or config.get('host', '0.0.0.0')
    if any(config.get(key) for key in ('https', 'tls_cert', 'tls_key', 'hostnames')):
        parser.error('内置 HTTPS 已移除，请删除旧的 TLS 配置，并通过外部反向代理提供 HTTPS。')
    configured_port = int(os.environ.get('SPOOLY_PORT', 0)) or config.get('port')
    port = args.port or configured_port or 8000
    try:
        media_sources = normalize_media_sources(config, getattr(args, 'media_source', None), media_root=media_root)
    except ValueError as exc:
        parser.error(str(exc))
    download_source = args.download_source or config.get('download_source') or 'default'
    vision_config = config.get('vision') or config.get('vision_config') or None
    embedding_config = config.get('embedding') or config.get('embedding_config') or None

    # Validate media directories.
    if not media_root and not media_sources:
        parser.error('请指定媒体目录：\n  - 命令行：ownflick /path/to/media\n  - 环境变量：MEDIA_ROOT=/path/to/media\n  - 配置文件：~/.config/spooly/config.yaml')

    if media_root:
        media_path = Path(media_root).expanduser()
        if not media_path.exists():
            print(f"错误：媒体目录不存在：{media_root}", file=sys.stderr)
            sys.exit(1)

        if not media_path.is_dir():
            print(f"错误：该路径不是目录：{media_root}", file=sys.stderr)
            sys.exit(1)
    else:
        media_path = Path(media_sources[0]['path'])

    unavailable_sources = []
    for source in media_sources:
        source_path = Path(str(source.get('path') or '')).expanduser()
        if not source_path.exists() or not source_path.is_dir():
            unavailable_sources.append((source.get('id'), source_path))

    if media_sources and len(unavailable_sources) == len(media_sources):
        print("错误：没有可用的媒体源", file=sys.stderr)
        for source_id, source_path in unavailable_sources:
            print(f"  @{source_id}: {source_path}", file=sys.stderr)
        sys.exit(1)
    if not media_root and unavailable_sources:
        unavailable_ids = {source_id for source_id, _ in unavailable_sources}
        first_available = next(
            source for source in media_sources if source.get('id') not in unavailable_ids
        )
        media_path = Path(str(first_available['path'])).expanduser()
    for source_id, source_path in unavailable_sources:
        print(f"警告：媒体源不可用，已保留其现有索引 @{source_id}：{source_path}", file=sys.stderr)

    # Set environment variables for Flask.
    os.environ['MEDIA_ROOT'] = str(media_path.absolute())

    # Start the server.
    print("正在启动 OwnFlick 服务器…")
    if media_sources:
        print("媒体源：")
        for source in media_sources:
            print(f"  @{source.get('id')}: {Path(str(source.get('path'))).expanduser().absolute()}")
    else:
        print(f"媒体目录：{media_path.absolute()}")
    print(f"数据目录：{get_data_dir()}")
    print(f"访问地址：http://{host}:{port}")

    try:
        app = create_app({
            "MEDIA_ROOT": media_path,
            "MEDIA_SOURCES": media_sources or None,
            "MEDIA_EXCLUDE": config.get('exclude'),
            "MEDIA_PRIVATE_FOLDERS": config.get('private_folders'),
            "DOWNLOAD_SOURCE": normalize_source_id(download_source),
            "VISION_CONFIG": vision_config,
            "EMBEDDING_CONFIG": embedding_config,
            "EXPERIMENTS": config.get('experiments'),
            "INSTANCE_NAME": args.name or config.get('name') or os.environ.get('SPOOLY_NAME'),
        })
    except ValueError as exc:
        parser.error(str(exc))
    bootstrap = app.extensions.get('auth_bootstrap')
    print("访问认证：已启用")
    if bootstrap and bootstrap.generated_password:
        print(f"初始访问密码：{bootstrap.generated_password}")
        print("请妥善保存；可执行 ownflick auth set-password 修改密码。")
    previous_sigterm = signal.signal(signal.SIGTERM, lambda *_: sys.exit(0))
    try:
        if getattr(args, 'dev', False):
            # Development mode uses Flask's built-in server.
            print("⚠️  已启用开发模式，请勿用于生产环境")
            app.run(host=host, port=port, debug=True, use_reloader=True)
        else:
            # Production mode uses Waitress. Cold thumbnails run ffmpeg, so allow a few more workers than the default 4.
            serve(app, host=host, port=port, threads=8)
    finally:
        signal.signal(signal.SIGTERM, previous_sigterm)


if __name__ == '__main__':
    main()
