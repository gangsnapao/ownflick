# Phase 5：文件夹浏览与合集连续播放

实现日期：2026-11-26。

## 文件夹浏览和起播

- 桌面侧栏与手机导航提供“文件夹”入口 `/folders`。先选择媒体来源，再按实际目录层级进入子文件夹；面包屑可返回上级。
- 卡片展示文件夹名称、缩略图、视频/图片数量，以及本级和包含子目录的媒体总数。数据使用已有媒体索引和 `/api/folders`，不在每次页面点击时重新扫描 NAS。
- 顶部选择“顺序播放”或“随机播放”，并切换是否包含子文件夹；当前目录和每张卡片均可直接起播。关闭递归后，本级没有媒体的文件夹禁用播放按钮，但仍可进入其子目录。
- 起播使用 `/flow?folder=...&recursive=true|false&order=sequential|random`，只读取该目录范围内的视频和图片。文件夹 URI、中文、空格、`&`、`#` 和 `%` 均通过 URL 参数编码传递。
- 文件夹流使用 Phase 2 的 `/api/feed` 分页。随机播放保留服务端返回的种子用于后续页面，避免每次翻页重新打乱；顺序与范围沿用 Phase 2 API 约定。
- 文件夹列表每页 24 项，支持加载更多；请求失败可重试，空目录显示说明。信息流读取失败或为空时保留明确状态，不回退到全库推荐。

## 合集进度与选集抽屉

- 合集详情页增加“播放合集”入口 `/flow?collection=<id>`。信息流底部显示合集名称与当前可播放位置，例如 `3 / 31`。
- 合集播放顺序沿用原合集成员顺序（最近加入的成员优先）。`GET /api/collections/<id>/flow` 通过索引按该顺序分页，仅包含视频和图片，并提供实际点赞/收藏状态。
- 进度分母来自可播放 feed 的 `total`；不能使用合集摘要的 `item_count`，因为后者可能包含音频和未进入当前索引的成员。合集名称与 feed 并行读取也不影响进度分母。
- 点击底部合集条打开半屏选集抽屉。列表展示文件名、缩略图、媒体类型和当前项高亮；可见视频按需读取浏览器元数据展示时长，读取失败时退回“视频”标签，不新增转码或 ffprobe 依赖。
- 抽屉每次加载 24 项，可继续加载后续选集。点击任意已列出的项目会定位对应合集索引；跨页跳转加载目标页，不把目标误当作全库索引。
- 跳到第 25 集等页首后，键盘、滚轮和触摸仍可返回前一页的上一集；前进到页尾时等待正在进行的预取，避免第一次翻页操作丢失。
- 抽屉隔离触摸与舞台翻页，方向键不会切换底层媒体；Tab 在抽屉按钮间循环，Space / Enter 保留原生按钮操作。关闭按钮、背景或 Escape 均可关闭；焦点回到合集条。
- 打开后立即关闭时，延迟返回的列表不会重新展开抽屉。清屏时隐藏合集条并关闭选集抽屉；退出清屏后恢复现有播放控件。
- 右侧“加入合集”继续使用现有共享选择器，可勾选合集或新建合集并加入当前视频/图片；图集仍针对当前图片，不另建重复的数据模型。

## 本阶段修复的边界问题

1. 视频时长观察器须在按钮子树组装完成后启动，否则 `IntersectionObserver.observe(null)` 会让选集列表中途失败，并造成重试偏移跳过该条目。
2. 合集摘要不能覆盖 feed 的可播放总数，避免响应先后顺序改变 `当前位置 / 总数`。
3. 跨页跳转后的上一条补载前页，触摸手势也采用同一处理。
4. 抽屉内 Space 不再被全局翻页快捷键拦截，保留选集、加载更多与关闭按钮的键盘激活。
5. 页尾翻页等待已有预取完成；关闭抽屉后不再由异步打开流程重新聚焦其中。
6. 新增文件夹导航后，600–740 像素高的桌面侧栏采用紧凑间距，保证包括退出登录在内的入口可触达。

## 主要文件

| 文件 | 作用 |
| --- | --- |
| `spooly/templates/folders.html` | 文件夹页面、递归开关和顺序/随机选项 |
| `spooly/static/folders_page_controller.js`、`folders.css` | 目录分页、计数、面包屑和带范围起播 |
| `spooly/web/browse.py` | 文件夹页面和已有浏览 API |
| `spooly/templates/base.html`、`spooly/static/app_navigation.css` | 双端文件夹入口及矮屏侧栏适配 |
| `spooly/templates/library.html`、`spooly/static/library.css` | 合集详情页起播入口 |
| `spooly/web/library.py`、`spooly/services/library_index.py` | 保持成员顺序的分页、合集播放 feed 与媒体类型过滤 |
| `spooly/templates/flow.html`、`spooly/static/flow.css` | 合集进度条和半屏抽屉 |
| `spooly/static/flow_page_controller.js` | 文件夹/合集范围、选集列表、跳转、页边界和异步状态 |
| `tests/test_collections.py`、`tests/test_web_runtime.py` | 合集分页、播放顺序、状态与路由回归 |
| `tests/browser/folders_collections.cjs` | 独立 Flask / SQLite / Chrome 的 Phase 5 浏览器回归 |

现有 `spooly` 包名、CLI、数据路径、自动迁移、认证与 CSRF 约定保持兼容；未增加运行时依赖。

## 自动化验证与构建

浏览器测试仅使用临时实例、SQLite、样例媒体及本机 Chrome，不连接用户媒体目录或 NAS；媒体字节来自项目自带样例，目录、索引、合集与状态 API 使用真实后端。新增 8 项浏览器用例覆盖：

1. 逐级进入中文/特殊字符目录、递归计数和顺序/随机起播。
2. 仅有后代媒体的文件夹在非递归模式下禁用起播。
3. 视频时长、当前项高亮、加载更多、跨页跳转和相邻播放顺序。
4. Space 激活按钮，以及第 25 集返回第 24 集后再次前进。
5. 移动触摸在跨页跳转后返回前一页。
6. 延迟摘要不覆盖可播放总数。
7. 列表仍在加载时关闭抽屉，确认不重新打开且焦点正确。
8. 移动抽屉边界、触摸隔离、清屏恢复和新建合集后真实成员保存。

复跑：

```bash
python -B -m pytest -q -ra -p no:cacheprovider
node --test tests/js/*.test.cjs
OWNFLICK_TEST_PYTHON=/path/to/python node --test tests/browser/*.cjs
npm run build
python -m pip wheel --no-deps --wheel-dir /tmp/ownflick-dist .
```

2026-11-26 最终复跑结果：

| 检查 | 结果 |
| --- | --- |
| Python 全量测试 | 310 passed、3 skipped；跳过项依赖本机缺少的 ffmpeg / ffprobe |
| JavaScript 单元测试 | 27 passed |
| Chrome 桌面/移动浏览器回归 | 39 passed，包含本阶段新增 8 项 |
| `npm run build` | 通过 |
| Python wheel 构建 | 通过 |
| Docker 镜像构建 | 未执行；本机无 Docker CLI |

测试 Python 需可导入项目依赖；可用 `CHROME_EXECUTABLE` 指定 Chrome，`OWNFLICK_SCREENSHOT_DIR` 指定已存在的截图目录。沿用前阶段本机的兼容 Python / Pillow 启动器，未为本机环境修改项目依赖。

Dockerfile 已核对：从当前源码构建 wheel，复制整个 `spooly` 包，现有生产 CSS 和新增模板/静态资源由包一同分发。实际 wheel 构建通过。**本机没有 Docker CLI，未运行 `docker build`，镜像验收仍待具备 Docker 的环境完成。**

已保存桌面、手机选集及导航截图，并通过浏览器 DOM 边界、命中与交互测试验证布局。当前模型不支持图像输入，未完成像素级截图审阅；Chrome 移动触屏模拟也不能替代 iOS Safari / Android 真机验收。

## 真机与部署验收

- 在手机 Safari / Chrome 中逐级打开 NAS 目录，核对本级/递归数量，并分别顺序和随机起播。
- 在至少 25 项的合集中打开抽屉，选第 25 集，再前后滑动穿过分页边界；确认位置、缩略图和实际媒体一致。
- 在横屏、安全区和矮屏下检查抽屉滚动、关闭和加载更多；底部合集条不与播放器进度条冲突。
- 在合集中清屏并连续切换媒体，退出后恢复合集条、点赞/收藏和进度控件。
- 新建或勾选合集后刷新，确认当前媒体仍在对应合集中。
- 在 Docker 环境执行 `docker build -t ownflick:phase5 .`，挂载隔离测试库后复核 `/folders` 和合集起播。
