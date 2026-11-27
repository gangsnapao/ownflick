# Phase 2：双状态、文件夹与受限信息流 API

本阶段只扩展 OwnFlick 后端，前端接入在后续阶段执行。原 `/api/feed/mix`、`/api/library/items`、收藏和合集入口保留。

## 数据与迁移

- SQLite 第 13 版迁移创建 `media_reactions`：`uri` 主键、`is_liked`、`liked_at`、`is_favorited`、`favorited_at`、`updated_at`，并创建两个状态/时间索引。
- 状态表独立于可重建的媒体索引，没有随 `media_items` 删除的级联关系。来源离线、排除规则变化或媒体暂时不在索引中时，用户状态仍保留。
- 启动时在同一 SQLite 写事务内，将数据目录的 `favorites.json` 字符串数组一次性导入，并写入 `data_migrations` 的 `favorites_json_v1` 标记。原文件保持原样，以后不再读取或写入它。
- 旧收藏只导入收藏状态，不自动变为点赞；裸相对路径规范为默认来源 URI。音频、离线来源和暂时缺失媒体的旧收藏均保留。
- 旧格式没有收藏时间，导入项使用同一个迁移时刻的 UTC 时间；相同时间按 URI 稳定排序，不推断历史操作顺序。
- 文件缺失时记录已完成空导入；格式损坏或读取/写入失败时不提交数据导入标记，原文件不被覆盖。修复原文件后重新启动可重试。
- 正常启动先导入再暴露状态接口。如果手动恢复的数据在缺少导入标记时已存在同 URI 的 SQLite 状态，则保留 SQLite 状态，不以旧 JSON 覆盖；回滚旧版本或并行运行写 JSON 的旧服务不会与新状态自动同步。
- `FavoriteService` 保留原来的查询、切换、设置、批量保存接口，实际状态统一存于 SQLite；推荐、统计和 Radio 使用同一收藏状态。合集继续使用原 JSON Store。
- 状态仍属于现有实例共享数据，没有新增用户账号或用户隔离语义。

## 媒体标识与通用约定

媒体 ID 就是现有规范 URI，例如 `@default/Travel/01.mp4`。路径参数应对整个 ID 执行 URL 编码；裸相对路径仍映射默认来源。文件夹根 URI 为 `@default/`，子目录为 `@default/Travel`。

新增 API 返回 `{ "success": true, "data": ... }`。启用认证时需要现有会话；POST 使用 `X-CSRF-Token` 或现有 `_csrf_token` 机制。错误参数返回 400，未知来源/目录/媒体返回 404，状态写入存储失败返回 503；认证与 CSRF 错误分别为 401 和 403。

## POST /api/media/:id/like 与 POST /api/media/:id/favorite

例如：`POST /api/media/%40default%2FTravel%2F01.mp4/like`。

- 不带请求体，或 JSON `{}`：切换对应状态。
- JSON `{ "state": true }`：确保对应状态开启。
- JSON `{ "state": false }`：确保对应状态关闭。
- `state` 必须为 JSON 布尔值；无效 JSON、null、数组或未知字段不会触发切换。
- 两个状态互不影响。重复设置为 true 不刷新状态时间，可用于后续双击点赞；关闭时对应时间置空，重新开启记录新时间。
- 新接口只接受索引中、当前排除规则允许的媒体；来源暂时离线但索引保留时仍允许设置。旧 `/api/favorite/<path:name>` 继续保留其既有兼容行为和响应格式。

响应示例：

```json
{
  "success": true,
  "data": {
    "id": "@default/Travel/01.mp4",
    "uri": "@default/Travel/01.mp4",
    "is_liked": true,
    "liked_at": "2026-11-26T00:00:00.000000+00:00",
    "is_favorited": false,
    "favorited_at": null
  }
}
```

## GET /api/folders

按层懒加载目录，不在 HTTP 请求中重新遍历 NAS：

- 无 `folder`：返回已配置媒体源的根节点。
- `folder=@default/`：返回默认来源根目录的直接子目录。
- `folder=@default/Travel`：返回该目录的直接子目录。
- `offset` 默认 0；`limit` 默认 24，允许 1–96，越界或无效值返回 400。

`data` 包含 `parent`、`current`、`items`、`total`、`offset`、`limit`、`next_offset`、`has_more`。`parent` 为本页子节点的父目录 URI，即请求中的规范 folder；无 folder 时为 null。`current` 是请求目录节点，无 folder 时为 null。

节点字段：

| 字段 | 含义 |
| --- | --- |
| `uri`, `source_id`, `path`, `name` | 目录身份；根 path 为空字符串，根名称使用来源配置名称 |
| `parent_uri` | 节点自身的上级目录；来源根为 null |
| `media_count`, `video_count`, `image_count` | 包含所有子目录的视频/图片总数及分类数，不计音频 |
| `direct_media_count` | 仅直属视频/图片数量 |
| `cover_uri`, `thumb_url` | 稳定路径排序后的首项封面；没有媒体时为空字符串 |
| `has_children` | 是否有可列出的子目录 |

目录树依据视频/图片索引补齐全部祖先，并包含所有配置源根。不主动枚举空目录和纯音频目录；直接指定现存空目录或纯音频目录时返回零计数与空列表。离线来源的已索引目录继续可查询，计数表示索引快照，不保证文件此时可播放。

目录名中的 `%`、`_` 和大小写按字面匹配，`a` 不会选中 `ab`。绝对路径、盘符、上级目录跳转、NUL、来源外符号链接、回收站和被排除目录均不可用。目录名内反斜杠在新查询层按字面保留，但原扫描/媒体交付层仍有既有的反斜杠规范化限制。

## GET /api/feed

参数：

| 参数 | 默认值与行为 |
| --- | --- |
| `folder` | 省略时查询所有来源；提供时限定来源和目录，格式与目录 API 相同 |
| `recursive` | `true`；只接受 `true` / `false`，对指定 folder 生效 |
| `order` | `sequential`；允许 `sequential` / `random` |
| `filter` | 省略时不按状态筛选；允许 `liked` / `favorited`，可与 folder 叠加 |
| `offset`, `limit` | 默认 0 / 24；limit 允许 1–96 |
| `seed` | random 未提供时自动生成并返回；后续分页必须复用该值，最长 512 字符 |

示例：

```text
/api/feed?folder=%40default%2FTravel&recursive=false&order=sequential&limit=24
/api/feed?folder=%40default%2FTravel&recursive=true&order=random&seed=trip-2026&offset=24
/api/feed?filter=liked&limit=24
/api/feed?filter=favorited&folder=%40nas%2FPhotos&recursive=true
```

- 普通 sequential 流按来源、相对路径字典序稳定升序；这是路径排序，不是媒体 mtime 排序或数字自然排序。
- liked/favorited 的 sequential 流按对应状态时间倒序，再按 URI 升序。
- random 根据 seed 与规范 URI 的 SHA-256 排序，保证候选不变时重放和跨页一致。索引或筛选成员变化后不承诺跨请求的旧快照；状态时间的幂等设置不影响排序。
- 数据范围先按来源、目录、递归与状态筛选；只返回单条 video/image，不插入全库推荐、回忆或相关图集。
- `total`、页内状态和分页结果读取同一个 SQLite 快照；空目录、没有匹配状态或超过末页时返回空 items。

`data` 包含 `items`、`total`、`offset`、`limit`、`next_offset`、`has_more`，并回传 `folder`、`recursive`、`order`、`filter`、`seed`。媒体项沿用 type/name/media_url/thumb_url/detail_url/mtime_ts/size_bytes/width/height，并增加 `id`、`is_liked`、`liked_at`、`is_favorited`、`favorited_at`。

当前实现对 SQL 选出的候选应用当前排除规则及来源边界校验，再分页；目录聚合和大范围随机流仍有线性候选处理与内存开销，没有新增持久快照、聚合缓存或运行依赖。大规模 NAS 的实际延迟需用真实库单独测量。

## 验证范围

后端测试覆盖旧 schema 升级、旧收藏导入/失败回滚/重启幂等、双状态时间与并发写入、旧接口及 Radio 兼容、逐级目录计数/封面/分页、路径边界、来源离线、排除规则、seed 重放与单次读取快照。前端进度条、清屏、独立按钮和目录入口不属于本阶段验收。

2026-11-26 在独立 Python 3.12 测试环境执行全量 `python -B -m pytest -q -ra -p no:cacheprovider`：294 passed、3 skipped。跳过的是依赖 ffmpeg/ffprobe 的视频相似度测试，与原始源码基线一致；测试环境另有一条原始基线也出现的 Requests 字符检测依赖警告。未修改项目依赖或构建配置，未连接实际 NAS/用户数据目录，未执行 Docker 构建。
