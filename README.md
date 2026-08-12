# Jive Backend

Jive 的模块化单体 VOD 后端。API 与 Worker 共享领域代码，但作为两个独立进程部署；目录来自 PostgreSQL，播放地址只在点击播放时解析且不长期落库。

## 本地启动

需要 Node.js 24、pnpm 10 和 Docker。

```bash
cp .env.example .env
docker compose up -d postgres redis-cache redis-queue
pnpm install
pnpm db:migrate
pnpm dev:api
pnpm dev:worker
```

API 默认位于 `http://localhost:3000`，Swagger UI 位于 `/docs`，指标位于 `/metrics`。也可直接 `docker compose up --build` 启动全部服务。生产部署必须替换两个 32 字符以上的 Token Secret、启用 TLS，并使用受控 Secret 管理。

## 同步和源接入

初始 migration 注册 `storm` 源。使用 Admin Token 调用 `POST /api/v1/admin/sources/src_storm/sync`，请求体 `{ "type": "full" }`。每个源有独立 `vod-sync:{source_code}` 队列。Source B 同时提供不可用占位实现 `source-b` 和可配置的兼容 HTTP 实现 `source-b-http`；后者通过 `SOURCE_B_BASE_URL` 接入同类 JSON 契约。未确认授权时不要在 Admin 中启用该源。

Storm URL 来自 `STORM_BASE_URL`，只允许 HTTPS，默认阻止回环、链路本地、私网和云元数据目的地址。仅在完全受控的本地测试环境才可设置 `SOURCE_ALLOW_PRIVATE_HOSTS=true`。接入任何真实源前，项目方必须确认内容、地区和商业授权。

## 运维

- migration 作为独立部署步骤执行，API/Worker 不自动迁移。
- Queue Redis 启用 AOF 和 `noeviction`；Cache Redis 可淘汰且不可作为事实来源。
- `/health/live` 只检查进程；`/health/ready` 强制检查 PostgreSQL，Cache Redis 失败仅降级。
- 全量同步只有完整遍历且无单条失败才累计缺失次数，连续两次缺失后才禁用映射。
- 修改源、线路、内容和映射的 Admin 操作写入脱敏审计日志。

## 验证

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
RUN_TESTCONTAINERS=1 pnpm test:integration
pnpm test:e2e
pnpm build
pnpm openapi:check
```

生产前还应在目标基础设施执行 `EXPLAIN ANALYZE`、负载测试、备份恢复、故障演练和真实授权源的低频 smoke test；这些依赖部署环境与合法凭据，不在普通 CI 访问公网执行。
