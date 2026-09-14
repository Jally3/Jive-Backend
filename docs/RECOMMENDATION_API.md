# Jive 个性化推荐客户端接口

接口版本：`v1`。推荐响应一律使用 `Cache-Control: private, no-store`。

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

## 事件

`POST /api/v1/recommendations/events` 接收最小化事件：`clientRequestId`、`sessionId`、`pageIndex`、
`candidatePosition`、`event`、`occurredAt`。不得上传标题、播放 URL、来源凭据或播放地址。成功返回 204。

允许的事件和完整字段约束以 [OpenAPI](./openapi.yaml) 为准。

## 错误处理

错误体统一为 `error.code/message/requestId/retryable`，可能附带 `retryAfterSeconds`。客户端应遵循
`Retry-After`，不得立即重试 429/503；504 可重试原 Cursor；410 应建立新会话；401 应重新签发主体。
请求体上限 64 KiB，客户端总超时建议 25～30 秒。
