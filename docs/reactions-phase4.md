# Phase 4：互动栏与双状态信息流

实现日期：2026-11-26。

## 当前行为

- Flow 右侧使用两个原生按钮：红心切换“点赞 / 取消点赞”，星标切换“收藏 / 取消收藏”。状态独立，各自使用 `aria-pressed`、忙碌状态及错误回滚。
- 双击视频、图片或图集当前图片，会播放红心动画并确保点赞开启。已点赞时再次双击只播放动画，不取消、不重复写入，也不刷新点赞时间；视频播放/暂停状态保持不变。
- 双击与按钮均使用 Phase 2 的显式状态接口：`POST /api/media/<encoded URI>/like|favorite`，请求体为 `{ "state": true|false }`，使用原会话及 CSRF 机制。
- 普通 `/api/feed/mix` 和 Forgotten 返回实际媒体的初始双状态，包括图集内每一张图片；在一个数据库读取快照中分块批量查询，不按媒体逐个连接数据库。读取不会改变状态时间。
- 图集的按钮和双击都作用于当前子项。请求按媒体 URI 和状态类型隔离，同一项的点赞与收藏可并行；切走后返回的旧响应不会覆盖新媒体的按钮，也不会提前解除新媒体的忙碌状态。
- 同一项同一种状态写入期间合并请求；若取消点赞尚未结束便双击，等待该请求结束后再确保点赞开启。失败只回滚失败的字段，可直接重试；提示通过现有 HUD 的实时区域播报。

## 我的点赞 / 我的收藏

- 桌面侧栏与手机导航菜单均有中文快捷入口：`/flow?filter=liked`、`/flow?filter=favorited`。
- 对应入口使用 `/api/feed?filter=liked|favorited&order=sequential&offset=...&limit=24`，按对应状态时间倒序播放视频和图片，不混入推荐卡片或无关媒体。顶部标签标识当前列表，可退出回普通 Flow。
- 空列表显示对应的点赞或收藏说明；请求失败显示重试入口，不回退全库推荐。
- 当前会话中取消点赞或收藏不会立即切走画面，便于撤销；刷新或重新进入后以数据库成员为准。
- 当前页面移除或恢复已经加载的成员时，修正后续偏移。下一页读取期间若对应状态发生写入，则丢弃该页，在相关写入结束后按修正偏移重新读取，避免 SQLite 快照在写入前后不同而漏掉边界媒体。
- 多浏览器、多个设备的并发成员变更仍遵循 Phase 2 的非持久快照约定；重新进入入口可取得最新状态。本阶段不新增跨设备实时推送或用户隔离。
- 原 `/favorite` Saved 网格、合集、Library Quick Viewer 和详情页继续保留既有入口与交互；本阶段双按钮范围为 Flow 及其两种状态列表。

## 手势与布局

- 操作栏隔离 pointer、touch、兼容鼠标、点击和滚轮；操作按钮会清除待执行的舞台单击，不会误切播放或翻页。
- 舞台拖动、长按、取消、丢失捕获及媒体切换会清除双击候选；双击须发生在同一实际媒体上，不把上张图的点击带到下一张。
- Phase 3 进度条定位、原播放状态恢复和清屏跨媒体保留继续有效。清屏时红心动画与操作栏一起隐藏。
- 矮屏操作栏可横排并按可用宽度换行，倍速菜单向可见区域展开；手机导航菜单限制在安全区内并可内部滚动，横屏也能访问顶部入口。

## 修改文件

| 文件 | 作用 |
| --- | --- |
| [flow.html](../spooly/templates/flow.html) | 独立红心、星标按钮及新控制器加载 |
| [base.html](../spooly/templates/base.html) | 双端导航入口和当前状态列表标记 |
| [flow_reactions_controller.js](../spooly/static/flow_reactions_controller.js) | 双状态缓存、独立请求、幂等点赞、失败回滚 |
| [flow_actions_shared.js](../spooly/static/flow_actions_shared.js) | 显式状态 POST 与响应校验 |
| [flow_page_controller.js](../spooly/static/flow_page_controller.js) | 操作栏、双击、图集子项、状态列表分页和写入竞态处理 |
| [flow.css](../spooly/static/flow.css) | 红心与星标状态、忙碌/焦点样式和矮屏布局 |
| [app_navigation.css](../spooly/static/app_navigation.css) | 安全区内可滚动的手机导航菜单 |
| [flow.py](../spooly/web/flow.py) | 普通混排流和 Forgotten 初始状态、当前筛选上下文 |
| [reactions.py](../spooly/services/reactions.py) | 同一快照下分块批量读取状态 |
| [app.py](../spooly/app.py) | 向 Flow 路由注入已有状态存储 |
| [flow_reactions_controller.test.cjs](../tests/js/flow_reactions_controller.test.cjs) | 状态控制器行为回归 |
| [flow_reactions.cjs](../tests/browser/flow_reactions.cjs) | 真实 Chrome、临时 SQLite / 媒体及真实 API 的交互回归 |
| [test_feed_mix.py](../tests/test_feed_mix.py)、[test_reactions.py](../tests/test_reactions.py) | 初始状态、批量读取、图集与媒体 URI 边界回归 |
| [flow-interaction-unification.md](flow-interaction-unification.md)、[README.md](README.md) | 更新交互约定与文档索引 |

## 自动化验证

2026-11-26 本地验证：

- `node --test tests/js/*.test.cjs`：27 passed（新增双状态控制器 6 项，原进度条 21 项）。
- `node --test tests/browser/flow_player.cjs`：10 passed；最终手势和矮屏修复后再次通过，覆盖桌面/移动拖动、取消、菜单及清屏连续切换五条混排媒体。
- Python 全量 `python -B -m pytest -q -ra -p no:cacheprovider`：308 passed、3 skipped。三个跳过项依赖当前环境未安装的 ffmpeg / ffprobe。
- `npm run build`：通过；最终播放器及双状态控制器 `node --check` 通过。生产 CSS 构建结果与阶段前一致，无需额外提交生成产物。
- 独立只读审查已检查双状态并发、手势候选、状态列表分页与矮屏菜单；确认的问题已修复并回归。批量读取按索引实际 URI 匹配，避免前导空格文件名与普通文件串状态或让混排流整体报错，旧未限定来源的名称仍按既有规范 URI 对齐。

测试使用临时实例、SQLite 和样例媒体，不连接用户媒体库或实际 NAS。浏览器回归使用本机 Chrome 的桌面与移动触屏模拟，不代替 iOS Safari / Android 真机。已保存截图并使用 DOM 边界及命中测试核对布局；当前模型不支持图片输入，未做像素级截图审阅。

复跑浏览器用例时，可用 `OWNFLICK_TEST_PYTHON` 指定可导入 Flask、Pillow 和项目依赖的 Python，`CHROME_EXECUTABLE` 指定 Chrome 可执行文件，`OWNFLICK_SCREENSHOT_DIR` 指定已存在的截图目录。沿用 Phase 3 的本地兼容 Pillow 测试启动器，没有为测试变更项目依赖。

## 手机真机验收点

1. 分别点击红心、星标，确认仅对应状态变化；刷新后状态保留，关闭其中一个不影响另一个。
2. 在视频、单图和图集上双击，确认红心点亮；已点赞后再次双击保持点赞，收藏不变，视频不被暂停。
3. 图集中左右切换，在不同图片上分别点赞/收藏，回切确认状态正确。
4. 从导航进入“我的点赞 / 我的收藏”，确认只播放对应成员，并按最近操作时间倒序；取消当前状态后继续上滑，返回入口确认已取消媒体消失。
5. 暂时断网后操作按钮，确认状态回滚并可重试；请求较慢时切下一条，确认新媒体按钮不串状态。
6. 拖动进度条和点击操作栏均不切屏；进入清屏后连续浏览视频、图片和图集，再退出确认控件恢复。
7. iOS Safari / Android Chrome 下检查横屏、矮屏和系统安全区，确认导航、倍速档位、红心、星标及进度条均可触达。

文件夹页面、文件夹起播与合集选集抽屉已在 [Phase 5](folders-collections-phase5.md) 接续实现；该文档同时记录 Docker 构建的环境限制与待验收项。
