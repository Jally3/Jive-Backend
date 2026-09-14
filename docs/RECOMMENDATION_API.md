# Jive 个性化推荐客户端接口

文档版本：`1.1`（2026-09-14）

接口版本：`v1`

生产 Base URL：`https://hey-rickytse.com`

本文档是 Jive 客户端接入个性化推荐的主文档。推荐响应一律使用
`Cache-Control: private, no-store`。现有 JSON 调用继续兼容，新版客户端应优先使用 NDJSON 流式返回。

## 客户端升级摘要

1. 推荐请求增加 `Accept: application/x-ndjson`。
2. 使用支持增量读取的网络 API；不得等待整个 response body 下载完成后再解析。
3. 按换行符逐行解码，每行都是一个独立 JSON 事件。
4. `item` 到达时可以临时展示或开始 VOD 匹配，但只有收到 `done` 后才能提交页面状态和上报事件。
5. 收到 `error`，或连接在 `done` 前结束时，丢弃该次请求的临时状态。

## 匿名主体

首次启动调用以下接口，并将返回值持久化到 Keychain/Keystore：

```http
POST /api/v1/recommendations/anonymous-subject
Content-Type: application/json

{}
```

成功返回 HTTP 201：

```json
{ "anonymousSubjectId": "v1...", "issuedAt": "2026-09-13T17:00:00.000Z" }
```

后续推荐和事件请求都携带 `X-Jive-Anonymous-Subject`。401 表示标识丢失、损坏或已因密钥轮换失效，
客户端应重新签发一次。

## 首页与续页

首页：

```http
POST /api/v1/recommendations/personalized
Content-Type: application/json
X-Jive-Anonymous-Subject: v1...

{"clientRequestId":"UUID","locale":"zh-CN","pageSize":24,"history":[],"library":[]}
```

续页只发送新 UUID 和服务端上一页返回的 Cursor：

```json
{ "clientRequestId": "UUID", "cursor": "v1..." }
```

同一 Cursor 可安全重试；服务端会重放首次成功结果，不重复生成。服务重启后内存会话丢失，旧 Cursor
返回 HTTP 410，客户端保留已经展示的内容，并用最新偏好创建新会话。

没有有效历史或收藏时返回 `mode=cold_start`、空 `items`，且不会调用 LLM。个性化响应包含候选、
`sessionId`、页信息和下一 Cursor；候选必须在客户端完成 VOD 严格匹配后才能进入可播列表。

### 流式返回

新版客户端在同一接口增加以下请求头，按 NDJSON 逐行接收推荐：

```http
Accept: application/x-ndjson
```

成功响应的 `Content-Type` 是 `application/x-ndjson; charset=utf-8`。不要使用 SSE `EventSource`：该接口
是 POST，响应虽然同样是流，但每条消息直接以换行分隔，不带 `data:` 前缀。

事件顺序固定为：

```text
start → item × 0..pageSize → done
                           ↘ error（生成开始后的失败）
```

完整成功示例：

```ndjson
{"type":"start","requestId":"req_...","clientRequestId":"UUID","mode":"personalized","source":"llm"}
{"type":"item","index":1,"item":{"title":"示例","originalTitle":"","aliases":[],"year":"","mediaType":"movie","category":"movie","latestSeasonNumber":null,"modelConfidence":0.5,"reason":""}}
{"type":"done","result":{"requestId":"req_...","clientRequestId":"UUID","generatedAt":"2026-09-14T00:00:00.000Z","servedAt":"2026-09-14T00:00:01.000Z","expiresAt":"2026-09-14T00:30:00.000Z","sessionId":"rec_...","mode":"personalized","source":"llm","items":[{"title":"示例","originalTitle":"","aliases":[],"year":"","mediaType":"movie","category":"movie","latestSeasonNumber":null,"modelConfidence":0.5,"reason":""}],"page":{"index":1,"pageSize":24,"hasMore":false,"nextCursor":null},"meta":{"requested":24,"llmReturned":1,"validAfterSchema":1,"duplicatesRemovedInPage":0,"duplicatesRemovedInSession":0,"returned":1,"cache":"miss"}}}
```

### 流事件定义

#### `start`

每个成功建立的流恰好出现一次，且必须是第一条：

| 字段              | 类型                         | 说明                       |
| ----------------- | ---------------------------- | -------------------------- |
| `type`            | `"start"`                    | 事件判别字段               |
| `requestId`       | string                       | 服务端请求 ID，用于排障    |
| `clientRequestId` | UUID string                  | 原样对应本次请求           |
| `mode`            | `personalized \| cold_start` | 推荐模式                   |
| `source`          | `llm \| none`                | `cold_start` 时固定为 none |

#### `item`

每个事件包含一个已完成字段清洗、页内去重和跨页去重的推荐候选：

| 字段    | 类型                      | 说明                          |
| ------- | ------------------------- | ----------------------------- |
| `type`  | `"item"`                  | 事件判别字段                  |
| `index` | integer，1～`pageSize`    | 当前页中的一基位置，严格递增  |
| `item`  | `RecommendationCandidate` | 候选；字段定义以 OpenAPI 为准 |

`item` 可以用于渐进式 UI 和预先发起 VOD 匹配，但此时仍是临时结果。客户端必须按 `index` 保持顺序，不能按
VOD 匹配完成先后重排。

#### `done`

成功流的最后一条事件：

| 字段     | 类型                   | 说明                                 |
| -------- | ---------------------- | ------------------------------------ |
| `type`   | `"done"`               | 事件判别字段                         |
| `result` | `RecommendationResult` | 与非流式 HTTP 200 完全相同的完整结果 |

`done.result.items` 会再次包含此前发送的所有 `item`，它是该页的权威结果。收到 `done` 后客户端应：

1. 用 `result.items` 替换临时列表，避免本地增量状态漂移。
2. 保存 `sessionId`、`page.index` 和 `page.nextCursor`。
3. 仅当 `page.hasMore=true` 且 `nextCursor` 非空时显示加载下一页入口。
4. 从此刻起才允许针对该页上报推荐匹配事件。

`cold_start` 的事件序列为 `start → done`，不会出现 `item`，也没有 `sessionId` 或 Cursor。

#### `error`

流开始后的失败无法再改变 HTTP 200 状态，因此会返回终止 `error` 事件：

```ndjson
{"type":"error","error":{"code":"RECOMMENDATION_UPSTREAM_TIMEOUT","message":"推荐服务响应超时","requestId":"req_...","retryable":true}}
```

`error.error` 字段与普通错误响应里的 `error` 相同。收到 `error` 或连接在 `done` 前断开时：

- 丢弃此次请求产生的临时 `item`、VOD 匹配结果和 Cursor 状态。
- 不得上报这次未提交页面的 `candidatePosition` 事件。
- 仅在 `retryable=true` 时重试；存在 `retryAfterSeconds` 时必须等待对应时间。
- 续页重试继续使用原 Cursor，但生成新的 `clientRequestId`。

未声明 `application/x-ndjson` 的旧客户端仍收到原有 `application/json` 响应。

### Swift 客户端读取示例

必须使用 `URLSession.bytes(for:)` 增量消费；`data(for:)` 会等待完整 body，不具备流式效果：

```swift
struct RecommendationStreamEnvelope: Decodable {
    let type: String
    let requestId: String?
    let clientRequestId: UUID?
    let mode: String?
    let source: String?
    let index: Int?
    let item: RecommendationCandidate?
    let result: RecommendationResult?
    let error: RecommendationAPIError?
}

func consumeRecommendations(_ requestBody: Data, subject: String) async throws {
    var request = URLRequest(
        url: URL(string: "https://hey-rickytse.com/api/v1/recommendations/personalized")!
    )
    request.httpMethod = "POST"
    request.httpBody = requestBody
    request.setValue("application/json", forHTTPHeaderField: "Content-Type")
    request.setValue("application/x-ndjson", forHTTPHeaderField: "Accept")
    request.setValue(subject, forHTTPHeaderField: "X-Jive-Anonymous-Subject")
    request.timeoutInterval = 30

    let (bytes, response) = try await URLSession.shared.bytes(for: request)
    guard let http = response as? HTTPURLResponse else { throw ClientError.invalidResponse }

    guard http.statusCode == 200 else {
        // HTTP 4xx/5xx 在流建立前返回，按普通 JSON 错误体读取和处理。
        throw ClientError.httpStatus(http.statusCode)
    }
    guard http.value(forHTTPHeaderField: "Content-Type")?
        .lowercased().hasPrefix("application/x-ndjson") == true else {
        throw ClientError.invalidContentType
    }

    var receivedDone = false
    for try await line in bytes.lines where !line.isEmpty {
        let event = try JSONDecoder().decode(
            RecommendationStreamEnvelope.self,
            from: Data(line.utf8)
        )
        switch event.type {
        case "start":
            beginTemporaryPage()
        case "item":
            guard let index = event.index, let item = event.item else {
                throw ClientError.invalidEvent
            }
            showTemporaryItem(item, at: index)
        case "done":
            guard let result = event.result else { throw ClientError.invalidEvent }
            commitAuthoritativePage(result)
            receivedDone = true
        case "error":
            throw event.error ?? ClientError.invalidEvent
        default:
            throw ClientError.invalidEvent
        }
    }
    guard receivedDone else { throw ClientError.incompleteStream }
}
```

客户端取消页面或发起新的推荐请求时，应取消对应 Swift `Task`，以便关闭 HTTP 流；不要让已经离开页面的
请求继续更新 UI。所有 UI 更新应回到 `MainActor`。

### 客户端状态机

| 当前状态  | 收到事件/结果        | 动作                                          |
| --------- | -------------------- | --------------------------------------------- |
| idle      | `start`              | 创建临时页，进入 streaming                    |
| streaming | `item`               | 按 index 临时展示和执行 VOD 匹配              |
| streaming | `done`               | 用 result 覆盖临时页并提交，进入 completed    |
| streaming | `error`/EOF/解码失败 | 丢弃临时页，进入 failed                       |
| completed | 加载下一页           | 使用 nextCursor 和新 clientRequestId 发起新流 |

一个连接中出现重复 `start`、`done` 后继续出现事件、`index` 不递增或未知 `type`，都应视为协议错误并丢弃
本次临时页面。

## 事件

`POST /api/v1/recommendations/events` 接收最小化事件：`clientRequestId`、`sessionId`、`pageIndex`、
`candidatePosition`、`event`、`occurredAt`。不得上传标题、播放 URL、来源凭据或播放地址。成功返回 204。

允许的事件和完整字段约束以 [OpenAPI](./openapi.yaml) 为准。

## 错误处理

错误体统一为 `error.code/message/requestId/retryable`，可能附带 `retryAfterSeconds`。客户端应遵循
`Retry-After`，不得立即重试 429/503；504 可重试原 Cursor；410 应建立新会话；401 应重新签发主体。
请求体上限 64 KiB，客户端总超时建议 25～30 秒。

即使请求声明了 `Accept: application/x-ndjson`，流建立前发生的参数、身份、限流或上游错误仍使用对应的
HTTP 4xx/5xx 状态和普通 `application/json` 错误体。只有已经收到 `start` 后的失败才表现为 HTTP 200
中的 `error` 事件。

| HTTP/错误                    | 客户端动作                                            |
| ---------------------------- | ----------------------------------------------------- |
| 400                          | 修正请求，不自动重试                                  |
| 401                          | 重新签发匿名主体一次，然后用新的 clientRequestId 重试 |
| 410                          | 丢弃旧 Cursor，保留已提交页面，用最新偏好创建新会话   |
| 413                          | 缩减请求；history 最多 20 项，library 最多 10 项      |
| 429                          | 遵循 `Retry-After`/`retryAfterSeconds`，不要立即重试  |
| 502                          | 本次结果不可用；依据 `retryable` 决定是否重试         |
| 503/504                      | 保留已提交页面；依据 `retryable` 和等待时间重试       |
| `error`/未收到 `done` 的 EOF | 丢弃当前临时页；不得推进 Cursor                       |

无论 HTTP 错误还是流内错误，`requestId` 都应写入客户端诊断日志，但不要把匿名主体、完整用户历史或 Cursor
写入普通日志。

## 兼容性与验收清单

- [ ] 请求包含 `Accept: application/x-ndjson`，且没有使用 `EventSource`。
- [ ] 网络层逐行处理 `bytes.lines`，没有使用 `data(for:)` 缓冲完整响应。
- [ ] `item` 只进入临时页面，`done.result` 才写入正式状态。
- [ ] `done.result.items` 覆盖临时列表，并保存返回的下一 Cursor。
- [ ] `error`、EOF、取消或解码失败都会清理临时状态。
- [ ] 续页每次生成新 `clientRequestId`，重试时复用原 Cursor。
- [ ] 401 只自动重新签发主体一次，410 会建立新推荐会话。
- [ ] 429/503/504 遵循服务端退避时间。
- [ ] 推荐事件只针对已经收到 `done` 的页面上报。
- [ ] 页面销毁或新请求取代旧请求时会取消旧 Swift `Task`。
