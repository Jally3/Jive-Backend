# Jive TMDB Catalog 客户端接口文档

文档版本：1.0  
接口版本：`v1`  
数据格式：UTF-8 JSON  
生产 Base URL：`https://hey-rickytse.com`

本文档面向移动端、桌面端和 Web 客户端。所有接口均为公开只读 GET 接口，不需要用户登录或
Authorization Header。服务端后台刷新 TMDB 数据，客户端请求不会直接触发 TMDB 抓取。

## 1. 快速接入

客户端推荐直接请求 Catalog API：

```http
GET /api/tmdb/v1/catalog?feed=latest
GET /api/tmdb/v1/catalog?feed=popular
GET /api/tmdb/v1/catalog?feed=top_rated
```

Feed 与产品 Tab 的对应关系：

| 客户端 Tab | `feed`      | 含义                                              | 服务端刷新周期 |
| ---------- | ----------- | ------------------------------------------------- | -------------: |
| 最新       | `latest`    | 最近上映、开播或更新新一集的内容                  |           1 天 |
| 热门       | `popular`   | TMDB 最近一周趋势内容                             |           3 天 |
| 高分       | `top_rated` | 评分不低于 7；综艺至少 20 票，其他内容至少 200 票 |           7 天 |

最小请求示例：

```bash
curl --compressed \
  'https://hey-rickytse.com/api/tmdb/v1/catalog?feed=popular'
```

### 浏览器跨域说明

当前服务没有返回 CORS 响应头，也没有提供 `OPTIONS` 预检接口。因此：

- 原生移动端、桌面端和服务端请求不受 CORS 限制。
- 与 `https://hey-rickytse.com` 同源的网页可以直接请求。
- 部署在其他域名上的 Web 客户端暂时不能直接从浏览器读取响应；接入前需要由服务端明确配置允许的
  Origin，不建议使用 `*` 放开全部来源。

## 2. 获取榜单

```http
GET /api/tmdb/v1/catalog?feed={feed}
```

### 查询参数

| 参数   | 必填 | 类型   | 允许值                           |
| ------ | ---- | ------ | -------------------------------- |
| `feed` | 是   | string | `latest`、`popular`、`top_rated` |

缺少 `feed` 或传入其他值均返回 HTTP 400。

### 成功响应

```json
{
  "schemaVersion": 1,
  "revision": "20260910T134410Z",
  "feed": "popular",
  "generatedAt": "2026-09-10T13:44:10.851Z",
  "expiresAt": "2026-09-14T13:44:10.851Z",
  "stale": false,
  "groups": {
    "all": ["tmdb:movie:550", "tmdb:tv:1399"],
    "movie": ["tmdb:movie:550"],
    "tv": ["tmdb:tv:1399"],
    "animation": [],
    "variety": []
  },
  "items": {
    "tmdb:movie:550": {
      "tmdbId": 550,
      "mediaType": "movie",
      "category": "movie",
      "localizedTitle": "示例电影",
      "originalTitle": "Example Movie",
      "originalLanguage": "en",
      "originCountries": ["US"],
      "aliases": [],
      "releaseDate": "2026-08-01",
      "sortDate": "2026-08-01",
      "rating": 8.1,
      "voteCount": 1200,
      "popularity": 98.5,
      "posterPath": "/example-poster.jpg"
    },
    "tmdb:tv:1399": {
      "tmdbId": 1399,
      "mediaType": "tv",
      "category": "tv",
      "localizedTitle": "示例剧集",
      "originalTitle": "Example Show",
      "originalLanguage": "en",
      "originCountries": ["US"],
      "aliases": [],
      "releaseDate": "2026-07-15",
      "sortDate": "2026-09-08",
      "latestSeasonNumber": 3,
      "rating": 8.4,
      "voteCount": 2300,
      "popularity": 85.2,
      "posterPath": "/example-show.jpg"
    }
  }
}
```

示例只用于说明结构，ID 和内容不代表生产数据。

### 顶层字段

| 字段            | 类型            | 说明                                                                            |
| --------------- | --------------- | ------------------------------------------------------------------------------- |
| `schemaVersion` | integer         | 当前固定为 `1`；数据结构不兼容变更时递增                                        |
| `revision`      | string          | 本次快照版本，可用于判断内容是否变化                                            |
| `feed`          | string          | 当前榜单类型                                                                    |
| `generatedAt`   | ISO 8601 string | 服务端成功生成快照的 UTC 时间                                                   |
| `expiresAt`     | ISO 8601 string | 快照开始被视为陈旧的 UTC 时间                                                   |
| `stale`         | boolean         | `true` 表示快照已超过 `expiresAt`；通常是后台刷新尚未成功，但旧数据仍在保留期内 |
| `groups`        | object          | 各展示分组的有序 Item ID 列表                                                   |
| `items`         | object          | 以稳定 Item ID 为 Key 的内容详情字典                                            |

### `groups`

| 字段        | 内容                                       |
| ----------- | ------------------------------------------ |
| `all`       | 总榜                                       |
| `movie`     | 普通电影，不包含归为动画的电影             |
| `tv`        | 普通电视剧，不包含归为动画或综艺的电视内容 |
| `animation` | 动画电影或动画电视内容                     |
| `variety`   | 综艺、真人秀、脱口秀等电视内容             |

综艺分组仅保留 TMDB 原始语言为中文（`zh`）、日语（`ja`）或韩语（`ko`）的内容；
其他语言或原始语言缺失的综艺不会进入榜单。该限制不影响电影、普通电视剧和动画。
三个榜单都会按这三种语言分别请求限定 Genre 的综艺候选，每个请求都使用
`TMDB_PAGES` 配置的页数，然后与各榜单的通用候选池合并去重。具体排序规则如下：

- 最新：新开播综艺使用首播日期；正在播出的老综艺查询详情后使用最新一集日期。
- 热门：按 TMDB 热度降序。
- 高分：按评分、票数降序，综艺最低 20 票。

数组顺序就是客户端展示顺序，每组最多 200 个 ID。同一内容会出现在 `all` 和一个具体分类中；
具体分类之间互斥。客户端应遍历目标 `groups[group]`，再用 ID 从 `items` 查详情：

```text
groups.movie = ["tmdb:movie:550"]
                         │
                         └─ items["tmdb:movie:550"]
```

不要依赖 `Object.keys(items)` 的顺序，也不要假设 `items` 中的每个对象都一定出现在 `groups.all`。

### `CatalogItem`

| 字段                 | 类型                                  | 是否可能缺省/空 | 说明                                                 |
| -------------------- | ------------------------------------- | --------------- | ---------------------------------------------------- |
| `tmdbId`             | positive integer                      | 否              | TMDB 原始媒体 ID                                     |
| `mediaType`          | `movie \| tv`                         | 否              | TMDB 媒体类型                                        |
| `category`           | `movie \| tv \| animation \| variety` | 否              | Jive 展示分类                                        |
| `localizedTitle`     | string                                | 否              | 优先使用中文标题，无中文时回退原始标题               |
| `originalTitle`      | string                                | 可能为空字符串  | 原始标题                                             |
| `originalLanguage`   | string                                | 旧快照可缺省    | TMDB 原始语言；新快照固定输出小写代码或空字符串      |
| `originCountries`    | string[]                              | 旧快照可缺省    | 来源国家/地区；新快照固定输出大写、去重代码          |
| `aliases`            | string[]                              | 可能为空数组    | 预留别名列表                                         |
| `releaseDate`        | `YYYY-MM-DD` string                   | 可能为空字符串  | 电影上映日或剧集首播日                               |
| `sortDate`           | `YYYY-MM-DD` string                   | 可能为空字符串  | 当前 Feed 使用的排序日期；老剧新季通常是最新一集日期 |
| `latestSeasonNumber` | positive integer                      | 可缺省          | 仅在识别到老剧更新新季时提供                         |
| `rating`             | number                                | 否              | TMDB 评分；上游缺失时为 `0`                          |
| `voteCount`          | non-negative integer                  | 否              | TMDB 评分票数；上游缺失时为 `0`                      |
| `popularity`         | non-negative number                   | 否              | TMDB 热度；只适合相对排序，不应展示成百分比          |
| `posterPath`         | string                                | 可能为空字符串  | TMDB 海报相对路径；本 API 不承诺图片 Base URL        |

客户端必须同时使用 `tmdbId + mediaType` 标识内容；电影和电视可能出现相同数字 ID。推荐直接使用服务端
提供的字典 Key，例如 `tmdb:movie:550`。

## 3. Manifest

```http
GET /api/tmdb/v1/manifest
```

响应示例：

```json
{
  "schemaVersion": 1,
  "language": "zh-CN",
  "feeds": {
    "latest": {
      "revision": "20260910T134404Z",
      "generatedAt": "2026-09-10T13:44:04.308Z",
      "expiresAt": "2026-09-12T01:44:04.308Z",
      "stale": false,
      "path": "latest.json"
    },
    "popular": {
      "revision": "20260910T134410Z",
      "generatedAt": "2026-09-10T13:44:10.851Z",
      "expiresAt": "2026-09-14T13:44:10.851Z",
      "stale": false,
      "path": "popular.json"
    },
    "top_rated": {
      "revision": "20260910T134411Z",
      "generatedAt": "2026-09-10T13:44:11.378Z",
      "expiresAt": "2026-09-18T13:44:11.378Z",
      "stale": false,
      "path": "top-rated.json"
    }
  }
}
```

服务预热或某个 Feed 超过最大保留期时，该 Feed 可能暂时不出现在 `feeds`。客户端不要将三个属性解析
为永远必填。

Manifest 缓存策略：

```http
Cache-Control: public, max-age=60
```

## 4. JSON 兼容路径

以下路径返回与 Catalog API 相同的 `CatalogSnapshot`：

| 路径                           | 等价请求                              |
| ------------------------------ | ------------------------------------- |
| `/data/tmdb/v1/latest.json`    | `/api/tmdb/v1/catalog?feed=latest`    |
| `/data/tmdb/v1/popular.json`   | `/api/tmdb/v1/catalog?feed=popular`   |
| `/data/tmdb/v1/top-rated.json` | `/api/tmdb/v1/catalog?feed=top_rated` |
| `/data/tmdb/v1/manifest.json`  | `/api/tmdb/v1/manifest`               |

注意：API 参数使用下划线 `top_rated`，文件名使用连字符 `top-rated.json`。

新客户端优先使用 `/api/tmdb/v1/catalog`；兼容路径适合需要固定 JSON URL 的旧客户端。

## 5. 缓存、ETag 与压缩

榜单响应包含：

```http
Cache-Control: public, max-age=300, stale-while-revalidate=3600
ETag: "20260910T134410Z-popular"
X-Catalog-Revision: 20260910T134410Z
X-Catalog-Stale: false
Vary: Accept-Encoding
```

客户端应保存响应体和 ETag。下次请求发送：

```http
If-None-Match: "20260910T134410Z-popular"
```

如果内容没有变化，服务返回：

```http
HTTP/1.1 304 Not Modified
```

304 没有响应体，客户端必须继续使用本地缓存，不能尝试解析空 Body。

推荐缓存流程：

```text
读取本地快照和 ETag
    ├─ 没有缓存 → 正常 GET → 保存 Body + ETag
    └─ 有缓存   → 带 If-None-Match GET
                     ├─ 200 → 替换本地 Body + ETag
                     ├─ 304 → 继续使用本地 Body
                     └─ 网络错误/5xx → 使用本地 Body 降级
```

服务支持 `br` 和 `gzip`。正常 HTTP 客户端通常会自动发送 `Accept-Encoding` 并自动解压，不建议业务
代码手工处理压缩数据。

## 6. `stale` 的客户端处理

`stale: true` 不等于请求失败，表示服务器正在使用最近一次成功快照。建议：

- 内容正常展示，不清空列表。
- 不必向普通用户展示醒目的错误。
- 可以在调试信息或轻提示中显示“数据更新时间”。
- 继续遵循 HTTP 缓存，不要因为 stale 高频轮询。

服务端最大保留期：

| Feed        |  软过期 | 最大保留 |
| ----------- | ------: | -------: |
| `latest`    | 36 小时 |     7 天 |
| `popular`   |    4 天 |    14 天 |
| `top_rated` |    8 天 |    30 天 |

超过最大保留期后，该 Feed 返回 HTTP 503，而不是无限返回旧数据。

## 7. 错误格式

除 `/health/ready` 外，业务错误统一为：

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "feed 仅支持 latest、popular、top_rated",
    "requestId": "req_536fe350-84f8-4626-b9ee-ef8c558d7470"
  }
}
```

| HTTP | `code`                | 场景                          | 客户端建议                        |
| ---: | --------------------- | ----------------------------- | --------------------------------- |
|  400 | `INVALID_ARGUMENT`    | `feed` 缺失或不合法           | 修正客户端参数，不重试            |
|  404 | `NOT_FOUND`           | 路径不存在                    | 检查接口版本和 URL，不重试        |
|  405 | `METHOD_NOT_ALLOWED`  | 使用 POST、HEAD 等非 GET 方法 | 改用 GET                          |
|  429 | `RATE_LIMITED`        | 请求超过限流                  | 按 `Retry-After` 等待，不立即重试 |
|  503 | `CATALOG_UNAVAILABLE` | Feed 尚未预热或超过最大保留期 | 使用客户端缓存，稍后退避重试      |
|  500 | `INTERNAL_ERROR`      | 未预期服务错误                | 使用客户端缓存，稍后退避重试      |

每个响应都包含 `X-Request-ID`。反馈服务端问题时，应同时提供：

- 请求 URL，不包含敏感参数。
- UTC 请求时间。
- HTTP 状态码。
- `X-Request-ID`。
- 错误响应体。

429 目前返回：

```http
Retry-After: 60
```

表示至少等待 60 秒。

## 8. 健康检查

### 存活

```http
GET /health/live
```

成功：

```json
{ "status": "ok" }
```

### 就绪

```http
GET /health/ready
```

正常时返回 200：

```json
{
  "ready": true,
  "status": "ok",
  "feeds": {
    "latest": "ok",
    "popular": "ok",
    "top_rated": "ok"
  }
}
```

存在 stale 快照时仍返回 200，但状态为 `degraded`：

```json
{
  "ready": true,
  "status": "degraded",
  "feeds": {
    "latest": "ok",
    "popular": "stale",
    "top_rated": "ok"
  }
}
```

缺少任意 Feed 时返回 503：

```json
{
  "ready": false,
  "status": "unavailable",
  "feeds": {
    "latest": "ok",
    "popular": "missing",
    "top_rated": "ok"
  }
}
```

健康检查主要供部署和监控使用。客户端正常加载 Tab 时直接请求 Catalog，不需要先调用健康检查，
否则会增加一次没有必要的往返。

## 9. 客户端请求策略

推荐：

1. App 启动时先展示本地持久化快照。
2. 后台用保存的 ETag 请求当前 Tab。
3. 切换 Tab 时按需加载对应 Feed，不必一次请求全部 Feed。
4. 200 时更新本地快照，304 时只更新客户端记录的“最近验证时间”。
5. 429 时严格遵循 `Retry-After`。
6. 500/503 或网络失败时保留旧列表，采用 30 秒、2 分钟、10 分钟的客户端退避。
7. 同一个 Feed 不要同时发起多个请求。
8. 即使服务端刷新周期较长，也遵循 `max-age=300`；ETag 会让未变化请求只返回 304。

不推荐：

- 每秒或每分钟轮询。
- 收到一次 503 就清空页面。
- 用数组位置作为内容身份。
- 把 `tmdbId` 单独作为跨电影/电视的全局 ID。
- 把 `popularity` 当成百分数展示。
- 假设日期和 `posterPath` 永远非空。

## 10. 类型定义参考

```ts
type FeedName = 'latest' | 'popular' | 'top_rated';
type MediaType = 'movie' | 'tv';
type Category = 'movie' | 'tv' | 'animation' | 'variety';

interface CatalogItem {
  tmdbId: number;
  mediaType: MediaType;
  category: Category;
  localizedTitle: string;
  originalTitle: string;
  originalLanguage?: string;
  originCountries?: string[];
  aliases: string[];
  releaseDate: string;
  sortDate: string;
  latestSeasonNumber?: number;
  rating: number;
  voteCount: number;
  popularity: number;
  posterPath: string;
}

interface CatalogSnapshot {
  schemaVersion: 1;
  revision: string;
  feed: FeedName;
  generatedAt: string;
  expiresAt: string;
  stale: boolean;
  groups: Record<'all' | Category, string[]>;
  items: Record<string, CatalogItem>;
}
```

客户端解码时建议允许服务端未来增加未知字段，但必须检查 `schemaVersion` 是否为客户端支持的版本。

## 11. 接口清单

| 方法 | 路径                                  | 客户端用途                 |
| ---- | ------------------------------------- | -------------------------- |
| GET  | `/api/tmdb/v1/catalog?feed=latest`    | 最新 Tab                   |
| GET  | `/api/tmdb/v1/catalog?feed=popular`   | 热门 Tab                   |
| GET  | `/api/tmdb/v1/catalog?feed=top_rated` | 高分 Tab                   |
| GET  | `/api/tmdb/v1/manifest`               | 查看各 Feed 版本和生成时间 |
| GET  | `/data/tmdb/v1/latest.json`           | 最新兼容路径               |
| GET  | `/data/tmdb/v1/popular.json`          | 热门兼容路径               |
| GET  | `/data/tmdb/v1/top-rated.json`        | 高分兼容路径               |
| GET  | `/data/tmdb/v1/manifest.json`         | Manifest 兼容路径          |
| GET  | `/health/live`                        | 运维存活检查               |
| GET  | `/health/ready`                       | 运维就绪检查               |

`/metrics` 是服务器本机运维接口，不属于客户端公开契约。
