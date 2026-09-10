# Jive Backend 项目地图

本文档按当前工作区中的轻量版 `Jive TMDB Catalog Lite` 整理，用来回答三个问题：

1. 从哪里启动？
2. 一次数据刷新和一次 HTTP 请求分别经过哪些模块？
3. 每个文件负责什么，修改某项功能时应该去哪里？

如果你正在学习 Node.js 后端，请同时阅读 [Node.js 后端学习指南](./NODE_BACKEND_LEARNING_GUIDE.md)。

## 一句话架构

这是一个无运行时第三方依赖的 Node.js 单进程服务：后台定时从 TMDB 拉取并整理三个榜单，
将快照缓存在内存（可选落盘），HTTP 层只读取快照，不在用户请求期间访问 TMDB。

```text
TMDB API
   │
   ▼
TmdbClient ──拉取、分页、限并发、重试──▶ CatalogGenerator
                                              │ 清洗、分类、排序、去重
                                              ▼
                                        CatalogService
                                      ┌───────┴────────┐
                                      │                │
                                  内存快照       可选状态文件
                                      │
                                      ▼
                                  HTTP Server ──▶ Jive 客户端
```

## 带注释的目录树

```text
Jive-Backend/
├── apps/
│   └── catalog/
│       └── src/
│           └── main.ts                 # 唯一进程入口；组装依赖、监听端口、处理退出信号
├── src/
│   ├── catalog.ts                      # 榜单生成规则；清洗、分类、排序、去重并生成快照
│   ├── catalog-policy.ts               # 三个 Feed 的刷新、过期、保留和失败退避策略
│   ├── catalog-service.ts              # 快照生命周期；定时刷新、缓存、过期降级、压缩与持久化
│   ├── config.ts                       # 读取、校验环境变量并提供安全默认值
│   ├── http-server.ts                  # HTTP 路由、限流、健康检查、指标、ETag 和压缩协商
│   ├── logger.ts                       # 输出一行一个 JSON 的结构化日志
│   ├── state-store.ts                  # 可选状态文件的原子写入、恢复及结构校验
│   ├── tmdb-client.ts                  # TMDB 客户端；鉴权、分页、并发限制、超时与重试
│   └── types.ts                        # Feed、条目、快照和持久化状态的共享类型与标识工具
├── test/
│   ├── catalog.spec.ts                 # 验证榜单分类、过滤、排序及“老剧新季”逻辑
│   ├── catalog-policy.spec.ts          # 验证刷新时间、保留窗口和指数退避序列
│   ├── catalog-service.spec.ts         # 验证刷新、落盘恢复、过期标记和失败保留旧快照
│   ├── config.spec.ts                  # 验证配置默认值、必填凭证和范围约束
│   ├── http-server.spec.ts             # 验证兼容路由、压缩、ETag/304 和就绪状态
│   └── state-store.spec.ts             # 验证状态原子存取及悬空条目引用校验
├── deploy/
│   ├── README.md                       # 部署文档入口和生产形态摘要
│   ├── DEPLOYMENT_RUNBOOK.md           # 当前服务器首次部署、升级、验证与回滚手册
│   └── jive-catalog.service            # systemd 单元；进程权限、资源限制和重启策略
├── docs/
│   ├── CLIENT_API.md                    # 给客户端开发者的接口、缓存和错误处理说明
│   └── openapi.yaml                     # 可导入工具和代码生成器的 OpenAPI 3.1 契约
├── scripts/
│   └── clean.mjs                       # 构建前删除 dist，防止旧产物残留
├── .github/
│   └── workflows/
│       └── ci.yml                      # GitHub Actions：安装、检查、测试和构建
├── .env.example                        # 可复制的环境变量模板，不含真实密钥
├── .gitignore                          # 排除依赖、构建产物、密钥文件、日志等
├── .prettierignore                     # 不参与 Prettier 格式化的生成文件/锁文件
├── .prettierrc.json                    # 代码格式：单引号、尾逗号、100 字符行宽
├── eslint.config.mjs                   # TypeScript 类型感知的 ESLint 规则
├── package.json                        # 项目标识、Node/pnpm 版本、开发命令和开发依赖
├── pnpm-lock.yaml                      # 锁定依赖的精确版本，保证安装和 CI 可复现
├── tsconfig.json                       # 开发与类型检查共用的严格 TypeScript 配置
├── tsconfig.build.json                 # 生产构建配置；继承主配置并排除测试
├── README.md                           # 面向使用者的接口、配置、运行和部署概览
├── NODE_BACKEND_LEARNING_GUIDE.md      # 面向初学者的项目式 Node.js 后端学习说明书
└── PROJECT_MAP.md                      # 本文档；面向开发者的代码导航
```

本地可能出现 `.DS_Store`、`.pnpm-store/`、`node_modules/`、`dist/` 和 `coverage/`。它们分别是
系统元数据、本地 pnpm 缓存、安装依赖、编译产物和覆盖率报告，不属于业务源码，也不应提交。

## 启动流程

入口是 `apps/catalog/src/main.ts`，执行顺序如下：

1. `loadConfig()` 读取并校验环境变量；缺少 TMDB Token 时立即失败。
2. 创建 `Logger` 和 `TmdbClient`。
3. 用 `TmdbClient` 创建 `CatalogGenerator`，再创建 `CatalogService`。
4. `CatalogService.start()` 尝试恢复状态文件，启动每分钟一次的调度器，并立即触发预热。
5. 创建 HTTP Server 并监听 `HOST:PORT`。
6. 收到 `SIGTERM` 或 `SIGINT` 后，停止刷新计时器并关闭 HTTP Server。

注意：`start()` 会触发后台预热，但不会等待三个 Feed 全部生成后才监听端口。因此刚启动且没有状态文件
时，`/health/live` 可以返回 200，而 `/health/ready` 和尚未生成的榜单会暂时返回 503。

## 榜单刷新流程

`CatalogService` 负责调度，`CatalogGenerator` 负责业务规则，二者刻意分离：

```text
每分钟 tick
  └─ 找到一个到期 Feed（同一时刻串行刷新）
      └─ CatalogGenerator.generate(feed)
          ├─ latest    → 近 180 天电影/新剧 + 正在播出的老剧新季
          ├─ popular   → 本周电影与剧集 Trending
          └─ top_rated → 评分 ≥ 7 且票数 ≥ 200 的电影与剧集
              └─ 标准化 → 过滤成人/无标题 → 分类 → 去重 → 排序 → 最多 200 条/组
                  └─ JSON 编码并预生成 gzip、Brotli 和 ETag
                      └─ 可选原子落盘
                          └─ 成功后替换内存快照
```

刷新失败时不会清空旧快照，而是按照 5 分钟、15 分钟、1 小时、6 小时封顶的节奏退避重试。
超过 Feed 自身的 `expiresAt` 后，旧快照会标记为 `stale` 继续服务；超过硬性保留期后才会视为
不可用。三个时间窗口和退避序列集中定义在 `src/catalog-policy.ts`。

## HTTP 请求流程

`src/http-server.ts` 使用 Node 原生 HTTP 模块，没有 Web 框架：

```text
请求
 ├─ 生成 x-request-id
 ├─ 拒绝非 GET 方法
 ├─ 健康检查 / 指标直接响应
 ├─ 按客户端 IP 做固定分钟窗口限流
 ├─ 解析 API 路由或 .json 兼容路由
 ├─ 从 CatalogService 读取快照
 ├─ If-None-Match 命中 → 304
 └─ 按 Accept-Encoding 返回 br / gzip / 原始 JSON
```

请求不会直接调用 `TmdbClient`。这种设计让上游 TMDB 变慢或短时故障时，已有快照仍能快速返回。
启用 `TRUST_PROXY=true` 后会采用 `X-Forwarded-For` 的第一个地址做限流键，因此只应在服务端口仅能被
可信反向代理访问时启用。

## 核心文件详解

### `apps/catalog/src/main.ts`

Composition Root（组装入口）。这里决定具体使用哪些实现，但不包含榜单算法或路由细节。新增一个需要
贯穿全进程的基础设施依赖时，通常从这里接线。

### `src/types.ts`

整个项目的数据契约中心：定义三个 Feed、媒体类型、互斥分类、Catalog 条目、快照结构和持久化结构。
`itemId()` 统一生成 `tmdb:movie:123` 形式的稳定 ID，`isFeedName()` 为 HTTP 输入提供类型收窄。

### `src/tmdb-client.ts`

唯一接触 TMDB HTTP API 的模块。第一页先确定总页数，后续页面并行获取，但全局通过 `Semaphore` 限制
并发。可重试 429 和常见 5xx，最多三次；4xx 等确定性错误不重试；同时限制超时与 2 MB 响应体。

### `src/catalog.ts`

领域逻辑中心。它把不稳定、字段可缺失的 TMDB 数据转换为稳定的 Catalog 数据：

- `latest` 组合近期首映内容与仍在更新的旧剧，并以最新一集日期作为老剧新季的排序日期。
- `popular` 合并电影和电视周趋势，按热度排序。
- `top_rated` 设置最低评分和票数门槛，按评分、票数排序。
- 动画优先归入 `animation`；电视真人秀/脱口秀等归入 `variety`；其余归入 `movie` 或 `tv`。
- `all` 是总榜，分类组互斥；每组最多 200 个 ID，实体内容统一存放在 `items` 字典中。

### `src/catalog-service.ts`

应用服务与运行时状态中心。它保证同一个 Feed 不会重复刷新、所有 Feed 的后台刷新串行进行，并管理
重试冷却。成功快照会一次性完成 JSON、gzip、Brotli 和 ETag 计算，使高频读取不重复做压缩工作。

### `src/state-store.ts`

可选的重启恢复层。写入时先生成同目录 `.tmp` 文件，再 `rename` 原子替换目标文件；读取时验证版本、
Feed 对应关系、组大小、重复 ID 和组内 ID 是否都能在 `items` 中找到。未配置路径时所有操作都是空操作。

### `src/http-server.ts`

传输层。集中维护路由、错误响应格式、缓存头、预压缩内容协商、请求日志、连接超时以及内存限流桶。
实现 `CatalogReader` 接口而非依赖具体类，因此测试可以用轻量 Stub。

### `src/config.ts` 与 `src/logger.ts`

`config.ts` 是进程边界的输入校验器，所有数字配置均有上下界，布尔值只接受 `true/false`；状态文件
会转换为绝对路径。`logger.ts` 按最低等级过滤日志，并输出适合 systemd/journald 收集的 JSON Lines。

## 修改需求时去哪里

| 需求                         | 首要文件                             | 通常一起检查                                     |
| ---------------------------- | ------------------------------------ | ------------------------------------------------ |
| 增加或修改 Feed              | `src/types.ts`、`src/catalog.ts`     | `src/catalog-service.ts`、路由、所有相关测试     |
| 调整榜单筛选/分类/排序       | `src/catalog.ts`                     | `test/catalog.spec.ts`                           |
| 调整 TMDB 请求、重试或分页   | `src/tmdb-client.ts`                 | 配置与上游模拟测试                               |
| 修改刷新频率、过期或降级策略 | `src/catalog-service.ts`             | `test/catalog-service.spec.ts`                   |
| 增加接口或响应头             | `src/http-server.ts`                 | `test/http-server.spec.ts`、`README.md`          |
| 增加环境变量                 | `src/config.ts`、`.env.example`      | `test/config.spec.ts`、`README.md`、部署环境文件 |
| 修改持久化格式               | `src/types.ts`、`src/state-store.ts` | schemaVersion、恢复测试和兼容策略                |
| 修改启动/优雅退出            | `apps/catalog/src/main.ts`           | systemd 单元、健康检查                           |
| 修改生产部署                 | `deploy/jive-catalog.service`        | `deploy/README.md`、根 `README.md`               |
| 修改检查/构建命令            | `package.json`                       | CI、TypeScript/ESLint/Prettier 配置              |

## 推荐阅读顺序

第一次接手时，建议依次阅读：

1. `README.md`：先了解产品能力与运行方式。
2. `src/types.ts`：掌握核心数据结构和命名。
3. `apps/catalog/src/main.ts`：看到完整依赖关系。
4. `src/catalog.ts`：理解榜单业务规则。
5. `src/catalog-service.ts`：理解刷新、缓存和降级。
6. `src/http-server.ts`：理解对外接口。
7. `src/tmdb-client.ts` 与 `src/state-store.ts`：理解两个外部边界。
8. 对应的 `test/*.spec.ts`：通过用例确认行为约束。

## 开发命令速查

```bash
pnpm dev            # 本地热重载启动
pnpm test           # 运行全部单元/接口测试
pnpm typecheck      # 只做 TypeScript 类型检查
pnpm lint           # ESLint 检查
pnpm format:check   # 检查格式，不修改文件
pnpm build          # 清理 dist 后编译生产代码
pnpm start          # 运行已经生成的 dist 产物
```

提交前建议依次执行 `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`。
