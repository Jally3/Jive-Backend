# Jive Backend

面向 Jive 客户端的轻量 TMDB 策展榜单与 LLM 个性化推荐服务。生产运行时只有一个 Node.js 进程，
不依赖 Docker、NestJS、PostgreSQL、Redis 或第三方运行时包。

首次阅读或准备修改代码时，请参阅 [项目地图](./PROJECT_MAP.md)，其中包含带注释的目录树、
启动/刷新/请求链路，以及每类需求对应的修改入口。

如果想通过本项目学习 Node.js 接口开发，请按 [Node.js 后端学习指南](./NODE_BACKEND_LEARNING_GUIDE.md)
中的阅读顺序和动手练习进行。

生产发布和服务器维护请遵循 [部署运行手册](./deploy/DEPLOYMENT_RUNBOOK.md)。该手册记录了当前
Nginx Stream、网站、Xray 与 Jive 共存环境的首次部署、升级、验证和回滚流程。

Catalog 客户端接入请使用 [客户端接口文档](./docs/CLIENT_API.md)，个性化推荐接入请使用
[推荐客户端接口](./docs/RECOMMENDATION_API.md)。工具和代码生成器可导入
[OpenAPI 3.1 定义](./docs/openapi.yaml)。

## 接口

```http
GET /api/tmdb/v1/catalog?feed=latest|popular|top_rated
GET /api/tmdb/v1/manifest
GET /data/tmdb/v1/latest.json
GET /data/tmdb/v1/popular.json
GET /data/tmdb/v1/top-rated.json
GET /data/tmdb/v1/manifest.json
GET /health/live
GET /health/ready
GET /metrics
GET /admin/
GET /admin/api/overview?days=30
POST /api/v1/recommendations/anonymous-subject
POST /api/v1/recommendations/personalized
POST /api/v1/recommendations/events
```

`.json` 兼容路径由内存动态返回，不生成对外静态文件。Catalog 请求不会实时访问 TMDB；
后台任务串行刷新 Feed，并在刷新失败时继续返回最近一次成功快照。

推荐会话和候选缓存只在进程内保存，重启后旧 Cursor 返回 410；每日调用、Token 和成本预算单独原子
落盘。默认关闭推荐功能，配置完整的方舟凭据、签名密钥、预算文件和价格后才能启用。

## 本地运行

需要 Node.js 24 和 pnpm 10：

```bash
cp .env.example .env
pnpm install
pnpm dev
```

Node 不会自动读取 `.env`。本地可以通过 shell 加载，生产环境由 systemd 的
`EnvironmentFile` 注入。

## 配置

| 环境变量                      | 默认值          | 说明                                 |
| ----------------------------- | --------------- | ------------------------------------ |
| `TMDB_READ_ACCESS_TOKEN`      | 必填            | TMDB Read Access Token               |
| `PORT`                        | `3000`          | 监听端口                             |
| `HOST`                        | `127.0.0.1`     | 默认只供本机反向代理访问             |
| `TMDB_API_BASE_URL`           | 官方 v3 地址    | 测试或代理地址                       |
| `TMDB_CONCURRENCY`            | `4`             | 列表与 Detail 共用的上游并发，最大4  |
| `TMDB_PAGES`                  | `5`             | 每个列表最多扫描页数，最大10         |
| `TMDB_REQUEST_TIMEOUT_MS`     | `10000`         | 单次请求超时，最大30秒               |
| `PUBLIC_RATE_LIMIT_MAX`       | `120`           | 每个远端地址每分钟请求数             |
| `TRUST_PROXY`                 | `false`         | 是否信任反向代理传入的客户端地址     |
| `CATALOG_STATE_FILE`          | 应用默认不启用  | 可选的单文件重启恢复状态             |
| `LOG_LEVEL`                   | `info`          | JSON日志等级                         |
| `ADMIN_ENABLED`               | `false`         | 启用只读监控后台；必须由反向代理鉴权 |
| `MONITORING_STATE_FILE`       | 应用默认不启用  | 每日监控聚合的独立状态文件           |
| `MONITORING_RETENTION_DAYS`   | `90`            | 每日统计保留天数                     |
| `MONITORING_TIMEZONE`         | `Asia/Shanghai` | 每日统计的日期时区                   |
| `MONITORING_SAVE_INTERVAL_MS` | `60000`         | 事件触发保存的最小间隔               |

设置 `CATALOG_STATE_FILE` 时，状态只用于服务重启恢复，不作为HTTP静态文件发布。写入采用
临时文件加原子重命名。留空则为纯内存模式，进程重启后需要重新预热。
生产 systemd 单元默认启用 `/var/lib/jive-catalog/state.json`，避免重启打断 1～7 天的刷新周期。

个性化推荐默认关闭。启用时，匿名主体由服务端签发；会话、Cursor 响应和 30 分钟/24 小时推荐缓存
只保存在内存，进程重启后旧 Cursor 返回 410。每日调用、Token 和成本预算独立原子保存到
`RECOMMENDATION_BUDGET_STATE_FILE`，避免通过重启绕过限额。完整参数见 `.env.example`，客户端契约
见 `docs/openapi.yaml`。

监控后台不进行前端轮询：打开页面时读取一次，之后只有点击“刷新数据”才会再次读取。HTTP、TMDB
和榜单刷新指标在事件发生时写入内存，并限频原子保存到独立的 `monitoring.json`。部署和鉴权方式见
[后台监控部署说明](./docs/ADMIN_MONITORING.md)。

## 刷新与降级策略

| Feed        | 正常刷新 | 标记 `stale` | 最大保留 |
| ----------- | -------- | ------------ | -------- |
| `latest`    | 1 天     | 36 小时      | 7 天     |
| `popular`   | 3 天     | 4 天         | 14 天    |
| `top_rated` | 7 天     | 8 天         | 30 天    |

刷新失败时保留最近一次成功快照，并按 5 分钟、15 分钟、1 小时、6 小时封顶的节奏退避重试；
任意一次成功刷新都会重置该 Feed 的连续失败次数。

## 构建与验证

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

正式发布前先更新 `package.json` 的语义版本，再运行统一发布命令：

```bash
pnpm release
```

发布包和 SHA-256 文件会生成在 `artifacts/`，同一版本不会被覆盖。生产服务器只需使用包内的
`dist`、`package.json` 和 systemd 配置，然后通过 Node 启动：

```bash
node dist/apps/catalog/src/main.js
```

示例服务单元位于 `deploy/jive-catalog.service`。当前生产环境由已有 Nginx 提供 HTTPS，并通过
`127.0.0.1:8443` 转发到仅监听环回地址的 Node 服务。当前 Stream 链路未保留可信客户端 IP，
因此生产配置保持 `TRUST_PROXY=false`；具体配置和限制见部署运行手册。
