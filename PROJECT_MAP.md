# Jive Backend 项目地图

本文档按当前工作区中的轻量版 `Jive TMDB Catalog Lite` 整理，用来回答三个问题：

1. 从哪里启动？
2. 一次数据刷新和一次 HTTP 请求分别经过哪些模块？
3. 每个文件负责什么，修改某项功能时应该去哪里？

如果你正在学习 Node.js 后端，请同时阅读 [Node.js 后端学习指南](./NODE_BACKEND_LEARNING_GUIDE.md)。

## 一句话架构

这是一个无运行时第三方依赖的 Node.js 单进程服务：后台定时从 TMDB 拉取并整理三个榜单；推荐接口
按需调用 Ark LLM，并用进程内会话和独立持久预算账本控制成本与并发。

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
│   ├── catalog.ts                      # CatalogGenerator 编排入口；保留稳定的公共导出
│   ├── catalog/
│   │   ├── domain.ts                   # 候选项、报告、上游接口、常量和业务阈值
│   │   ├── normalize.ts                # TMDB 字段清洗、语言/地区归一化和 Detail 合并
│   │   ├── grouping.ts                 # 分组、排序、去重、配额校验和快照构建
│   │   └── report.ts                   # 生成统计、排除样本和元数据告警
│   ├── catalog-policy.ts               # 三个 Feed 的刷新、过期、保留和失败退避策略
│   ├── catalog-service.ts              # 快照生命周期；定时刷新、缓存、过期降级、压缩与持久化
│   ├── admin-page.ts                   # 零前端依赖的只读后台监控页面
│   ├── config.ts                       # 读取、校验环境变量并提供安全默认值
│   ├── http-server.ts                  # HTTP 路由、限流、健康检查、指标、ETag 和压缩协商
│   ├── logger.ts                       # 输出一行一个 JSON 的结构化日志
│   ├── monitoring-service.ts           # HTTP/TMDB/刷新指标的每日聚合与保留策略
│   ├── monitoring-store.ts             # 监控状态的校验、恢复和原子保存
│   ├── monitoring-types.ts             # 监控事件、每日指标和持久化结构
│   ├── recommendation/
│   │   ├── ark-client.ts               # 方舟 Chat Completions 调用、超时、响应上限和错误映射
│   │   ├── budget-store.ts             # 每日主体/全局次数、Token、成本的原子持久预算账本
│   │   ├── controls.ts                 # 推荐独立限流、全局并发、有界队列和 429 冷却
│   │   ├── cursor.ts                   # 主体绑定的签名 Cursor 及不可逆摘要
│   │   ├── prompt.ts                   # Prompt 构建和调用前 Token 保守估算
│   │   ├── service.ts                  # 首页、续页、缓存、分页和同 Cursor single-flight 编排
│   │   ├── store.ts                    # 有界的进程内会话和新鲜/陈旧 LRU 缓存
│   │   ├── subject.ts                  # 服务端匿名主体签发与无状态验签
│   │   ├── types.ts                    # 推荐 DTO、会话和结构化错误
│   │   └── validator.ts                # 输入/模型输出校验、清洗和稳定去重
│   ├── recommendation/
│   │   ├── service.ts                  # 首页/续页编排、缓存、去重和同 Cursor single-flight
│   │   ├── ark-client.ts               # Ark JSON 调用、超时、响应上限和错误映射
│   │   ├── budget-store.ts             # 每日主体/全局调用、Token、成本的原子持久账本
│   │   ├── controls.ts                 # 推荐低频限流、全局并发、有界队列和 429 冷却
│   │   ├── store.ts                    # 有界进程内会话和新鲜/陈旧 LRU 缓存
│   │   ├── subject.ts                  # 服务端匿名主体签发与无状态验签
│   │   ├── cursor.ts                   # 主体绑定的签名 Cursor
│   │   ├── prompt.ts                   # Prompt 构造和调用前 Token 保守估算
│   │   ├── validator.ts                # 输入、模型输出校验及候选稳定去重
│   │   └── types.ts                    # 推荐 DTO、会话和结构化错误
│   ├── state-store.ts                  # 可选状态文件的原子写入、恢复及结构校验
│   ├── tmdb-client.ts                  # TMDB 客户端；鉴权、分页、并发限制、超时与重试
│   └── types.ts                        # Feed、条目、快照和持久化状态的共享类型与标识工具
├── test/
│   ├── catalog.spec.ts                 # 验证榜单分类、过滤、排序及“老剧新季”逻辑
│   ├── catalog-policy.spec.ts          # 验证刷新时间、保留窗口和指数退避序列
│   ├── catalog-service.spec.ts         # 验证刷新、落盘恢复、过期标记和失败保留旧快照
│   ├── config.spec.ts                  # 验证配置默认值、必填凭证和范围约束
│   ├── http-server.spec.ts             # 验证兼容路由、压缩、ETag/304 和就绪状态
│   ├── monitoring-service.spec.ts       # 验证监控聚合、时区、保留和持久化
│   ├── recommendation.spec.ts           # 验证签名、校验、预算落盘和 Cursor 并发合并
│   ├── state-store.spec.ts              # 验证状态原子存取及悬空条目引用校验
│   └── tmdb-client.spec.ts              # 验证 TMDB Detail 缓存和请求合并
├── deploy/
│   ├── README.md                       # 部署文档入口和生产形态摘要
│   ├── DEPLOYMENT_RUNBOOK.md           # 当前服务器首次部署、升级、验证与回滚手册
│   └── jive-catalog.service            # systemd 单元；进程权限、资源限制和重启策略
├── docs/
│   ├── ADMIN_MONITORING.md              # 后台监控的数据口径、鉴权和部署说明
│   ├── CLIENT_API.md                    # 给客户端开发者的接口、缓存和错误处理说明
│   ├── RECOMMENDATION_API.md             # 推荐主体、分页、事件和错误恢复接入说明
│   └── openapi.yaml                     # 可导入工具和代码生成器的 OpenAPI 3.1 契约
├── scripts/
│   ├── clean.mjs                       # 构建前删除 dist，防止旧产物残留
│   └── package-release.mjs             # 生成版本化发布包和 SHA-256 校验文件
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
├── artifacts/                          # 本地发布产物；由 pnpm release 生成，不提交 Git
├── README.md                           # 面向使用者的接口、配置、运行和部署概览
├── NODE_BACKEND_LEARNING_GUIDE.md      # 面向初学者的项目式 Node.js 后端学习说明书
└── PROJECT_MAP.md                      # 本文档；面向开发者的代码导航
```

本地可能出现 `.DS_Store`、`.pnpm-store/`、`node_modules/`、`dist/`、`coverage/` 和 `artifacts/`。
它们分别是系统元数据、本地 pnpm 缓存、安装依赖、编译产物、覆盖率报告和发布包，不属于业务源码，
也不应提交。

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
          ├─ latest    → 近 180 天新作 + 最近 14 天更新的合格老作品，按 14:6 分块
          ├─ popular   → 本周电影与剧集 Trending + 中日韩综艺候选池
          └─ top_rated → 评分 ≥ 7；电影/普通剧集票数 ≥ 200，中日韩综艺票数 ≥ 20
              └─ 规范语言/地区 → 过滤成人/无标题 → Detail 补全 → 分类/去重/排序
                  └─ latest 五组独立配额；其他 Feed 每组最多 200 条
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

唯一接触 TMDB HTTP API 的模块。第一页先确定总页数，后续页面并行获取，但列表和 Detail 全局共用
`Semaphore` 限制并发。可重试 429 和常见 5xx，最多三次；4xx 等确定性错误不重试；同时限制超时与
2 MB 响应体。Movie/TV Detail 支持同 Key 在途合并、成功/失败 TTL 缓存和请求统计。

### `src/catalog.ts`

领域逻辑中心。它把不稳定、字段可缺失的 TMDB 数据转换为稳定的 Catalog 数据：

- `latest` 将最近 180 天首映内容与最近 14 天更新的老作品分池；清理非华语 Soap、超长和高频日播
  普通电视剧，五个分组独立按每 20 条最多 6 条 returning 的规则稳定合并。
- `popular` 合并电影和电视周趋势，同时为中日韩综艺分别请求按热度排序的限定 Genre 候选池，
  全部候选合并去重后按热度排序。
- `top_rated` 为中文、日语、韩语综艺分别请求限定 Genre 的候选池，综艺最低 20 票，
  电影和普通剧集最低 200 票，合并后按评分、票数排序。
- 动画优先归入 `animation`；电视真人秀/脱口秀等归入 `variety`；综艺只接受 zh/ja/ko；其余归入
  `movie` 或 `tv`。所有新快照 Item 都输出原始语言和来源国家/地区。
- `all` 是总榜，分类组互斥；每组最多 200 个 ID，实体内容统一存放在 `items` 字典中。

### `src/catalog-service.ts`

应用服务与运行时状态中心。它保证同一个 Feed 不会重复刷新、所有 Feed 的后台刷新串行进行，并管理
重试冷却。成功快照会一次性完成 JSON、gzip、Brotli 和 ETag 计算，使高频读取不重复做压缩工作。

### `src/state-store.ts`

可选的重启恢复层。写入时先生成同目录 `.tmp` 文件，再 `rename` 原子替换目标文件；读取时验证版本、
Feed 对应关系、组大小、重复 ID 和组内 ID 是否都能在 `items` 中找到。恢复旧状态时允许缺少新增语言
字段；保存新快照前使用严格模式校验字段格式。未配置路径时所有操作都是空操作。

### `src/http-server.ts`

传输层。集中维护路由、错误响应格式、缓存头、预压缩内容协商、请求日志、连接超时以及内存限流桶。
实现 `CatalogReader` 接口而非依赖具体类，因此测试可以用轻量 Stub。

### `src/config.ts` 与 `src/logger.ts`

`config.ts` 是进程边界的输入校验器，所有数字配置均有上下界，布尔值只接受 `true/false`；状态文件
会转换为绝对路径。`logger.ts` 按最低等级过滤日志，并输出适合 systemd/journald 收集的 JSON Lines。

## 修改需求时去哪里

| 需求                         | 首要文件                                | 通常一起检查                                     |
| ---------------------------- | --------------------------------------- | ------------------------------------------------ |
| 增加或修改 Feed              | `src/types.ts`、`src/catalog.ts`        | `src/catalog/`、CatalogService、路由和相关测试   |
| 调整榜单编排                 | `src/catalog.ts`                        | `src/catalog/`、`test/catalog.spec.ts`           |
| 调整字段清洗或语言地区判断   | `src/catalog/normalize.ts`              | `src/catalog/domain.ts`、Catalog 测试            |
| 调整分类、排序、去重或配额   | `src/catalog/grouping.ts`               | `src/catalog/domain.ts`、Catalog 测试            |
| 调整生成报告或排除样本       | `src/catalog/report.ts`                 | `src/catalog/domain.ts`、后台监控                |
| 调整 TMDB 请求、重试或分页   | `src/tmdb-client.ts`                    | 配置与上游模拟测试                               |
| 修改刷新频率、过期或降级策略 | `src/catalog-service.ts`                | `test/catalog-service.spec.ts`                   |
| 增加接口或响应头             | `src/http-server.ts`                    | `test/http-server.spec.ts`、`README.md`          |
| 修改后台监控                 | `src/admin-page.ts`、`src/monitoring-*` | HTTP 测试、监控文档和 systemd 配置               |
| 增加环境变量                 | `src/config.ts`、`.env.example`         | `test/config.spec.ts`、`README.md`、部署环境文件 |
| 修改持久化格式               | `src/types.ts`、`src/state-store.ts`    | schemaVersion、恢复测试和兼容策略                |
| 修改启动/优雅退出            | `apps/catalog/src/main.ts`              | systemd 单元、健康检查                           |
| 修改生产部署                 | `deploy/jive-catalog.service`           | `deploy/README.md`、根 `README.md`               |
| 修改检查/构建命令            | `package.json`                          | CI、TypeScript/ESLint/Prettier 配置              |
| 修改发布包内容               | `scripts/package-release.mjs`           | `package.json`、部署运行手册                     |

## 目录与项目地图维护规范

1. `apps/` 只放进程入口和依赖组装，不承载业务规则。
2. `src/` 根目录保留跨功能公共模块和稳定入口；同一领域超过约 500 行或包含三个以上独立职责时，拆到
   同名子目录。
3. `src/catalog.ts` 是 Catalog 的稳定入口。调用方默认从这里导入，不跨目录依赖内部实现；
   `src/catalog/` 内部模块可以互相协作，但不得反向依赖 `apps/`。
4. 持久化、HTTP、TMDB 等外部边界与纯业务规则分离。纯规则模块不得直接读取环境变量、文件或网络。
5. 测试集中在 `test/`，文件名与被测公共模块对应。内部拆分不要求机械增加测试文件，优先测试可观察行为。
6. `dist/`、`coverage/`、`artifacts/`、依赖目录和本机状态不得提交 Git。发布包只能由
   `pnpm release` 生成到 `artifacts/`。
7. 新增、删除、移动模块或改变模块职责时，必须在同一变更中更新本文件的目录树、“修改需求时去哪里”
   表格；接口变化还要同步 `docs/openapi.yaml` 和对应说明文档。
8. 正式发布必须先更新 `package.json` 的语义版本。相同版本的发布包禁止覆盖，脚本会主动拒绝。

## 结构变更记录

| 日期       | 版本  | 变更                                                                                                                                 | 兼容性                                                     |
| ---------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| 2026-09-13 | 1.0.4 | 将 Catalog 的领域定义、归一化、分组排序和报告逻辑拆入 `src/catalog/`；新增统一发布脚本与 `artifacts/` 目录规范；补齐后台监控项目地图 | `src/catalog.ts` 的公共导出保持不变；HTTP 和持久化格式不变 |

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
pnpm release        # 完整检查后生成 artifacts/ 下的发布包与 SHA-256
```

提交前建议依次执行 `pnpm lint && pnpm format:check && pnpm typecheck && pnpm test && pnpm build`。
