# OwnFlick · 中文信息流

将本地图片和视频放进媒体库，打开首页即可像刷短视频一样全屏浏览。本项目基于 [Oddloaf 维护的 OwnFlick（原 Spooly）](https://github.com/oddloafhq/ownflick) 进行本地需求改造，围绕**抖音式信息流体验**做了大量功能增强与性能优化。

只提供**信息流**和**媒体库**两个主要入口，已停用原首页、音乐电台、在线下载和独立合集页面。

## 功能特性

### 信息流播放（类抖音体验）

- **免点击起播**：进入信息流自动静音起播；首次点击后自动开声，右下角「点击开声」引导胶囊可一键开声
- **预热秒开**：前方 5 个视频梯度预载（+1 首帧预热、+2~+5 元数据预取），上滑切换流畅跟手；省流/慢网络自动降级
- **手势操作**（详见下方手势表）：中央单击播放/暂停、双击点赞、竖滑切条、横滑拖动进度、长按弹倍速菜单（0.5x–2x）、左缘竖滑调亮度、右缘竖滑调音量
- **清屏播放**：一键清屏，屏幕只剩一条细线进度条；右上角「退出清屏」按钮（闲置自动淡出 30%），双击屏幕也可退出
- **右侧工具抽屉**：速度、放大镜、点赞、收藏、静音、合集、详情、重新打乱、清屏全部收纳进抽屉；点把手垂直弹出/卷收，闲置降至 30% 透明度
- **进度条**：可拖动调节播放进度，显示已播/总时长；清屏时只留细线不遮挡画面
- **无限回看**：向上回看不设限，超 300 条才丢弃最旧内容并提供「回到最新」按钮
- **续播记忆**：同一浏览器恢复当前媒体、随机轮次和视频秒数；可点「重新打乱全库」开启新一轮
- **PWA**：支持添加到主屏幕，standalone 竖屏模式，首次访问有引导条

### 媒体库与整理

- **文件夹网格**：按文件夹浏览/筛选媒体，支持进入/返回上级、筛选胶囊
- **批量管理**：批量选择 → 加入合集、移到回收站、永久删除
- **回收站**：批量恢复/清空（两步确认），不会自动永久清空
- **合集**：收藏、点赞的视频自动分别进入「收藏」「点赞」合集，可单独播放合集内容；支持手动新建合集
- **隐私文件夹**：标记为私密的目录不进入全库信息流，只能在该文件夹内单独播放
- **文案显示**：文件名自动清洗为简洁文案（隐藏日期前缀与尾部编号），支持按文案搜索
- **搜索**：按文件名、文案、路径搜索；多文件导入、重新扫描、确认删除

### 性能与工程

- **随机流快照缓存**：索引 revision + 目录 mtime 双失效，万级媒体库信息流响应毫秒级
- **缩略图治理**：生成单飞去重 + 并发闸门，避免扫描风暴
- **一键部署**：`scripts/deploy-nas.sh` 同步源码 → 备份镜像 → 构建 → 更新容器 → 健康检查，支持 `--rollback` 一键回滚

## 手势速查

| 区域 | 单击 | 双击 | 竖滑 | 横滑 | 长按 |
|------|------|------|------|------|------|
| 左缘 | — | 点赞 | 调亮度 | 拖动进度 | 倍速菜单 |
| 中央 | 播放/暂停 | 点赞 | 切换视频 | 拖动进度 | 倍速菜单 |
| 右缘 | — | 点赞 | 调音量 | 拖动进度 | 倍速菜单 |
| 清屏中 | 中央：播放/暂停 | 退出清屏 | 切换视频 | 拖动进度 | 倍速菜单 |

## 快速开始

### 源码运行

需要 Python 3.10+，可选安装 `ffmpeg`/`ffprobe`（生成视频缩略图与元数据，缺失时用占位图）。

```bash
python3 -m venv .venv
source .venv/bin/activate
python -m pip install -e .
python -m spooly.run ~/Movies --host 127.0.0.1 --port 8000
```

打开 `http://127.0.0.1:8000`，首次启动会在终端显示登录密码。手机访问时绑定 `0.0.0.0` 并访问电脑局域网 IP。

### Docker 运行

```bash
docker run -d --name ownflick \
  -p 8000:8000 \
  -e TZ=Asia/Shanghai \
  -v /path/to/video:/media \
  -v ./spooly-data:/data \
  ghcr.io/oddloafhq/ownflick:latest
```

也可使用 [compose.yaml](compose.yaml)（`docker compose up -d`）。首次启动的登录密码见 `docker logs ownflick`。

### NAS 一键部署

`scripts/deploy-nas.sh` 提供面向私有 NAS（群晖等）的一键部署与回滚，首次使用前配置环境变量：

```bash
export NAS_HOST="user@nas-host"
export NAS_DIR="/path/to/ownflick"              # NAS 上的构建上下文目录
export COMPOSE_DIR="/path/to/docker/ownflick"   # docker compose 项目目录
export NAS_DEPLOY_HELPER="/path/to/nas_deploy.py"  # 可选：docker 需要 sudo 时的提权助手

scripts/deploy-nas.sh            # 部署
scripts/deploy-nas.sh --rollback # 回滚到上次备份镜像
```

## 配置

### 多媒体源

```bash
.venv/bin/python -m spooly.run ~/Movies --media-source photos=/path/to/photos
```

或使用配置文件（`~/.spooly/config.yaml`，或 `SPOOLY_INSTANCE` 指定的目录）：

```yaml
media_sources:
  - id: default
    name: 视频
    path: ~/Movies
  - id: photos
    name: 图片
    path: ~/Pictures
port: 8000
exclude:
  - "cover.jpg"
```

媒体源可增删改挂载目录；隐私文件夹、合集等在媒体库界面管理。离线源不会丢弃已有索引，随机信息流会跳过不可访问的文件。

### 导入限制

默认单次最多 50 个文件、单文件 512 MiB、请求总大小 1 GiB，可在 Flask 配置调整：

```python
LIBRARY_IMPORT_MAX_FILES = 50
LIBRARY_IMPORT_MAX_FILE_BYTES = 512 * 1024 * 1024
LIBRARY_IMPORT_MAX_REQUEST_BYTES = 1024 * 1024 * 1024
```

反向代理有上传大小限制时需同步调整代理配置。

### 其他

- 时区 `TZ`：影响时间线与「历史上的今天」
- `SPOOLY_NAME`：实例名称；`SPOOLY_PORT`：端口
- `FLASK_AUTH_COOKIE_SECURE=true`：HTTPS 反代后启用
- 浏览器续播数据存于站点本地存储，不跨设备同步

## 开发与测试

```bash
python -m pip install pytest
npm install
npm run build           # Tailwind CSS 构建
python -m pytest -q --ignore=tests/browser
node --test tests/js/*.test.cjs tests/test_flow_session.cjs
```

已安装 Chrome 时可运行端到端验收：

```bash
OWNFLICK_TEST_PYTHON=.venv/bin/python node --test tests/browser/chinese_flow.cjs
```

代码结构：界面在 `spooly/templates` 与 `spooly/static`，后端路由在 `spooly/web`，媒体索引/导入/洗牌/性能缓存逻辑在 `spooly/services`。开发规范见 [AGENTS.md](AGENTS.md)。

## 来源与许可

本项目基于 Oddloaf 维护的 OwnFlick（原 Spooly）进行本地需求改造。原项目身份和 MIT 许可保留，详见 [LICENSE](LICENSE)。
