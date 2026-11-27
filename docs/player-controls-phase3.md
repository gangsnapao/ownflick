# Phase 3：播放器进度条与清屏模式

状态：2026-11-26 完成开发及本地自动化验证。手机 Safari / Chrome 真机体验仍需按下文验收。

## 当前行为

### 底部视频进度条

- 视频显示底部进度条；普通图片及图集不显示视频控件。未取得有效有限时长时禁用定位。
- 常态轨道为 3px，触控区域为 44px；按下后轨道放大至 7px，显示圆形滑块和 `当前时间 / 总时长` 浮层。
- Pointer Events 配合指针捕获处理鼠标和触屏。按下暂停视频，拖动只更新预览，松手按最终坐标定位；原先播放的视频继续播放，原先暂停的视频保持暂停。
- 底部控件隔离 pointer、touch、兼容鼠标、滚轮和点击事件。拖动期间锁住外层切屏；操作不能同时触发上下切换、图集切换或双击收藏。
- 取消及丢失捕获会放弃预览；切媒体、失焦、切后台及离页会清理捕获、浮层和切屏锁，旧媒体不会被重新播放。
- 聚焦进度条后保留原生方向键、Home / End 定位及辅助技术 input / change 路径。连续定位使用首帧初始化标记，不因前一次 seek 暂时降低 readyState 而忽略下一次操作。
- 原舞台横向拖动继续可用，增加丢失捕获、失焦、隐藏和离页取消路径；暂停时的播放提示会在拖动结束后恢复。

### 清屏模式

- 右侧操作栏提供“清屏播放”按钮；右下角半透明“退出清屏”按钮或 Escape 恢复界面。
- 清屏隐藏导航、操作栏、进度条、标题、图集计数、播放提示及常规 HUD。加载失败等需要用户处理的状态仍可展示。
- 清屏状态跨视频、图片和图集切换保留。图集水平切换和信息流上下切换保持可用。
- 隐藏操作层使用 inert 退出键盘焦点顺序；关闭的倍速菜单、合集弹窗和状态层使用 visibility 隐藏。正常播放中清屏后，Tab 不会进入这些隐藏控件。
- 开启清屏会取消在途拖动、关闭倍速和合集选择器、关闭放大镜；退出后恢复操作层及焦点。
- 状态保存在当前页面的状态控制器中，页面刷新后回到普通模式；本阶段不增加跨浏览器或跨设备的清屏偏好。
- 合集选择器打开时，全局方向键不再切走底层媒体，避免用户在弹窗中操作时媒体发生变化；Escape 关闭倍速或合集菜单。

### 播放流畅性与资源窗口

- 播放页只保留当前视频及前后最近的视频解码资源；离开窗口的视频会暂停、解除 `src` 并调用 `load()` 释放浏览器解码器，回看时按上次位置恢复。
- 预加载延迟到当前视频稳定播放后执行，并遵守 `Save-Data` 与慢速网络提示；图片只在当前媒体附近加载，减少长时间上下滑动的带宽和内存占用。
- 页面进入后台会停止视频和进度刷新，回到前台后只恢复原先正在播放的媒体，避免后台抢占 CPU / 网络。
- 进度条改为约 30Hz 的轻量刷新循环，仍保留 `timeupdate`、键盘和拖动定位路径；请求视频帧等待超时会取消已登记的帧回调。

## 实现位置

| 文件 | 作用 |
| --- | --- |
| [flow.html](../spooly/templates/flow.html) | 进度条、时间预览、清屏及退出入口，按依赖顺序加载控制器 |
| [flow_progress_controller.js](../spooly/static/flow_progress_controller.js) | 底部定位生命周期、精确坐标提交、取消与事件隔离 |
| [flow_page_controller.js](../spooly/static/flow_page_controller.js) | 接入播放器、手势锁、暂停提示、菜单隔离及清屏 UI |
| [flow_state_controller.js](../spooly/static/flow_state_controller.js) | 清屏状态及与放大镜互斥，沿用 immersive 兼容入口 |
| [flow.css](../spooly/static/flow.css) | 轨道与滑块、预览、清屏过渡、退出按钮和隐藏层焦点规则 |
| [output.css](../spooly/static/output.css) | 生产 Tailwind 构建产物 |
| [flow_progress_controller.test.cjs](../tests/js/flow_progress_controller.test.cjs) | 无浏览器依赖的行为测试 |
| [flow_player.cjs](../tests/browser/flow_player.cjs) | 真实页面桌面与移动触屏浏览器回归 |
| [flow-interaction-unification.md](flow-interaction-unification.md) | 更新清屏保留规则、底部拖动约定和回归清单 |

本阶段继续使用现有混排信息流和收藏接口。点赞/收藏双按钮、双击点赞语义及状态信息流入口属于 Phase 4；文件夹页面与合集选集抽屉属于 Phase 5。

## 自动化验证

2026-11-26 本地结果：

- `node --test tests/js/flow_progress_controller.test.cjs`：21 passed。
- `node --test tests/browser/flow_player.cjs`：10 passed。使用临时 Flask 实例、隔离数据目录、项目自带样例视频和图片，以及真实 Chrome；移动端使用 390 × 844 视口和 CDP 触屏输入。信息流与非本阶段的收藏/合集响应使用固定测试数据。
- Python 全量 `python -B -m pytest -q -ra -p no:cacheprovider`：294 passed、3 skipped。三个跳过项需要 ffmpeg / ffprobe；环境保留一条 Requests 字符检测依赖警告。
- `npm run build`：通过，重新生成生产 CSS；播放器 JavaScript 语法检查通过。
- 复核最终文件差异及独立只读代码审查，已修复连续定位丢失、舞台拖动锁残留和隐藏菜单键盘问题。

浏览器用例验证了：桌面拖动中预览且不提交、松手定位与暂停保持、移动触摸取消与恢复播放、无效元数据和失焦清理、舞台捕获丢失/失焦/隐藏/离页后恢复切屏、菜单键盘隔离、桌面及移动端清屏连续切换五条媒体、图集水平切换、退出后恢复控件。

复跑浏览器测试需要安装项目依赖和本机 Chrome，并让 `OWNFLICK_TEST_PYTHON` 指向可导入 Flask、Pillow 等项目依赖的 Python。可用 `CHROME_EXECUTABLE` 指定浏览器可执行文件、`OWNFLICK_SCREENSHOT_DIR` 指定已存在的截图目录。测试会自动启动并关闭仅供测试的本地服务。

本机旧临时虚拟环境的 Pillow 扩展存在 macOS Team ID 签名不匹配；验证时仅通过 PYTHONPATH 优先使用本机已兼容的 Pillow。没有为此改动项目依赖、用户媒体库或部署配置。

## 真机验收点

1. 手机 Safari / Chrome 播放视频，拖动进度条并上下偏移手指；只有时间预览变化，不切屏，松手落到目标时间。
2. 分别在播放、暂停时定位，确认结束后保留原播放状态；拖动中切后台后返回，确认仍能上下切换。
3. 开启清屏，连续切换至少五个视频/图片，并在图集中左右滑动；界面持续清屏，只有退出入口可操作。
4. 点击退出或使用 Escape 后，导航、操作栏、图集计数及视频进度条按当前媒体类型恢复。
5. 横屏、刘海屏及底部系统手势区检查，确认进度条和退出按钮容易触达且没有遮挡冲突。

自动化覆盖 Chrome 桌面与移动模拟，不代替 iOS Safari / Android 真机；Docker 构建验收保留在 Phase 5。
