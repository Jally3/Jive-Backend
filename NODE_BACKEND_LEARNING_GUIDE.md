# 用当前项目学习 Node.js 后端

这不是一份脱离项目的 Node.js 语法大全，而是一条可以边读、边运行、边修改的学习路线。
目标是：你最终能解释一次请求怎样进入服务、怎样得到数据、怎样返回响应，并能独立增加一个小接口。

建议先搭配 [项目地图](./PROJECT_MAP.md) 阅读。项目地图回答“文件在哪里”，本文回答“为什么这样写、
应该怎样学”。

## 1. 先建立后端的基本模型

一个最小后端只需要完成四件事：

```text
客户端发 HTTP 请求
       ↓
服务器识别方法和路径（路由）
       ↓
执行校验、业务逻辑、读写数据或调用外部服务
       ↓
返回 HTTP 状态码、响应头和响应体
```

在当前项目中，它们分别对应：

| 后端概念                 | 当前项目中的实现           |
| ------------------------ | -------------------------- |
| 程序入口                 | `apps/catalog/src/main.ts` |
| HTTP 服务器和路由        | `src/http-server.ts`       |
| 业务规则                 | `src/catalog.ts`           |
| 应用服务、缓存和定时任务 | `src/catalog-service.ts`   |
| 调用外部 API             | `src/tmdb-client.ts`       |
| 数据结构                 | `src/types.ts`             |
| 配置                     | `src/config.ts`            |
| 持久化                   | `src/state-store.ts`       |
| 行为验证                 | `test/*.spec.ts`           |

这个项目没有使用 Express、NestJS 或数据库，直接使用 Node 原生的 `node:http`。它很适合学习 HTTP
后端的本质：框架以后会替你简化路由和中间件，但请求、响应、状态码、异步操作和分层不会消失。

## 2. 需要先会多少 JavaScript/TypeScript

不用把整门语言学完再开始。先掌握下面这些就够读懂本项目：

- `const`、`let`、函数、对象、数组、`Map` 和 `Set`。
- `import` / `export`：一个文件如何使用另一个文件公开的能力。
- `interface` 和 `type`：描述数据应该长什么样。
- 类、构造函数和 `private readonly`：对象如何保存依赖和状态。
- `Promise`、`async` / `await`、`try` / `catch`：如何等待网络和文件操作。
- 数组的 `map`、`filter`、`sort`：本项目榜单生成的主要工具。
- 联合类型，例如 `'movie' | 'tv'`：值只能来自有限选项。
- `undefined`、可选字段 `?` 和类型收窄：处理外部 API 的缺失数据。

项目采用 ESM 和 TypeScript 的 `NodeNext` 模式。因此源码虽然是 `.ts`，相对导入仍写成
`'./logger.js'`。TypeScript 编译后文件会变成 `.js`，这个写法让 Node.js 在生产环境直接找到编译产物；
不要因为源文件扩展名是 `.ts` 就随意把导入改成 `.ts`。

## 3. 第一次把项目跑起来

### 3.1 先运行不需要 TMDB Token 的检查

```bash
pnpm install
pnpm typecheck
pnpm test
```

测试使用 Stub 或内存数据，不需要访问真实 TMDB。建议先让测试全部通过，再开始修改代码。

### 3.2 启动真实服务

```bash
cp .env.example .env
```

编辑 `.env`：

- 把 `TMDB_READ_ACCESS_TOKEN` 换成自己的 TMDB Read Access Token。
- 本地学习时使用 `TRUST_PROXY=false`。
- 本地没有 `/var/lib/jive-catalog` 写权限时，把 `CATALOG_STATE_FILE` 留空，使用纯内存模式。

当前启动命令不会自动读取 `.env`。在 zsh 中可以这样加载：

```bash
set -a
source .env
set +a
pnpm dev
```

另开一个终端观察接口：

```bash
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
curl -i 'http://127.0.0.1:3000/api/tmdb/v1/catalog?feed=popular'
curl -i http://127.0.0.1:3000/metrics
```

重点观察：

- 第一行的状态码，例如 `200`、`304`、`400`、`503`。
- `content-type`、`etag`、`cache-control`、`x-request-id` 等响应头。
- 终端中每行 JSON 日志的 `message`、`statusCode` 和 `durationMs`。
- 服务刚启动时，存活检查可能成功，但就绪检查会等榜单预热后才成功。

## 4. 沿着一次启动读代码

首先打开 `apps/catalog/src/main.ts`。不要一开始钻进每个函数，只看对象如何被组装：

```text
loadConfig
  ↓
Logger + TmdbClient
  ↓
CatalogGenerator
  ↓
CatalogService.start
  ↓
createCatalogServer
  ↓
server.listen
```

这叫依赖组装。`CatalogGenerator` 不自己创建 TMDB 客户端，而是通过构造函数接收一个上游对象；
`CatalogService` 也通过构造函数接收生成器和日志器。这样做的直接好处是测试时可以替换成假的实现，
无需访问网络。

读完后，尝试不看代码回答：

1. 哪一行开始监听端口？
2. 哪一行开始恢复和刷新榜单？
3. 收到 `SIGTERM` 时，哪些资源会停止？

## 5. 沿着一次 HTTP 请求读代码

打开 `src/http-server.ts`，从 `createCatalogServer()` 开始顺序阅读。

### 5.1 请求和响应是什么

Node 原生服务器的回调接收两个核心对象：

- `request`：客户端发来的方法、URL、请求头和连接信息。
- `response`：服务端用来设置状态码、响应头和响应体。

当前项目的核心模式可以简化为：

```ts
const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://localhost');

  if (request.method !== 'GET') {
    response.writeHead(405, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: '仅支持 GET' }));
    return;
  }

  if (url.pathname === '/health/live') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ status: 'ok' }));
  }
});
```

项目把重复响应逻辑提取成了 `json()` 和 `failure()`，把路由识别提取成 `routeFeed()`，让主流程更容易读。

### 5.2 按下面顺序追踪一个请求

以 `GET /api/tmdb/v1/catalog?feed=popular` 为例：

1. 创建请求 ID，并写入 `x-request-id`。
2. 用 `new URL()` 拆出 `pathname` 和查询参数。
3. 检查是否为 GET。
4. 健康检查和指标路由优先处理。
5. 按客户端 IP 检查限流。
6. `routeFeed()` 把 `feed=popular` 收窄成合法 `FeedName`。
7. `options.catalog.get('popular')` 从内存读取快照。
8. `sendSnapshot()` 处理 ETag 和 gzip/Brotli，然后结束响应。
9. `finally` 记录状态码与耗时。

这里最重要的设计是：用户请求只读内存，不等待 TMDB。上游慢或临时故障不会直接拖慢每个用户请求。

### 5.3 理解常见状态码

| 状态码 | 本项目中的含义                          |
| ------ | --------------------------------------- |
| `200`  | 请求成功                                |
| `304`  | 客户端持有相同 ETag，可继续使用本地缓存 |
| `400`  | `feed` 参数不合法                       |
| `404`  | 没有这个路径                            |
| `405`  | 使用了非 GET 方法                       |
| `429`  | 单个客户端一分钟请求过多                |
| `503`  | 榜单还未生成或已经超过硬性保留期        |
| `500`  | 未预料到的服务内部错误                  |

## 6. 沿着一次数据刷新读代码

刷新链路是：

```text
CatalogService.tick()
  → CatalogService.refresh(feed)
  → CatalogGenerator.generate(feed)
  → TmdbClient 对 TMDB 发请求
  → 清洗、分类、排序、去重
  → 生成 CatalogSnapshot
  → 可选 saveState()
  → 替换内存缓存
```

分三次阅读，不要一次理解所有细节：

### 第一遍：只看职责

- `src/tmdb-client.ts` 负责“可靠地取得原始数据”。
- `src/catalog.ts` 负责“把原始数据变成产品需要的榜单”。
- `src/catalog-service.ts` 负责“什么时候刷新、失败怎么办、怎样提供快照”。

### 第二遍：看异步控制

- `Promise.all()` 让互不依赖的 TMDB 请求并行执行。
- `Semaphore` 控制实际并发，避免同时向上游发送太多请求。
- `AbortSignal.timeout()` 限制单次请求等待时间。
- `TmdbClient.request()` 对 429 和常见 5xx 最多重试三次。
- `CatalogService.active` 防止同一 Feed 重复刷新。
- 刷新失败保留旧快照，并按 5 分钟、15 分钟、1 小时、6 小时封顶的节奏退避重试。

### 第三遍：看数据转换

从 `normalize()` 开始看最容易：它将 TMDB 电影和电视的不同字段转换成统一 `CatalogItem`。之后再看：

- `category()` 如何判断电影、电视、动画和综艺。
- `dedupe()` 如何用稳定 ID 去重并排序。
- `buildSnapshot()` 如何建立 ID 列表和 `items` 字典。
- `revision()` 如何产生版本号。

## 7. 类型、接口和依赖注入怎样帮助后端

`src/types.ts` 不执行网络或业务操作，它定义系统内部的共同语言。例如 `CatalogSnapshot` 能让：

- 生成器知道应该返回什么。
- 服务层知道应该缓存什么。
- HTTP 层知道正在发送什么。
- 状态存储知道应该验证什么。
- 测试知道夹具应该长什么样。

项目中的 `CatalogUpstream`、`SnapshotGenerator`、`CatalogReader` 是三个很值得学习的小接口。它们只描述
调用方真正需要的方法，而不要求调用方知道具体类。这种方式称为依赖倒置或面向接口编程。

例如测试中的 `StubTmdb implements CatalogUpstream` 可以完全代替真实 `TmdbClient`。学习时先理解这种
实际收益，不必急着背设计模式名称。

## 8. 怎样读测试

测试不是附属品，而是可执行的需求说明。建议使用这个循环：

1. 选一个测试文件，只读测试名称 `it('...')`。
2. 猜测被测代码应该怎样工作。
3. 阅读准备数据、执行动作和断言。
4. 回到源码寻找对应实现。
5. 临时修改一个断言或实现，观察失败信息，然后撤销实验改动。

运行单个文件：

```bash
pnpm exec vitest run test/http-server.spec.ts
pnpm exec vitest run test/catalog.spec.ts
```

一个典型测试可以按 Arrange、Act、Assert 理解：

```ts
// Arrange：准备假的依赖和输入
const tmdb = new StubTmdb();

// Act：调用真正想验证的行为
const snapshot = await new CatalogGenerator(tmdb).generate('popular');

// Assert：检查输出是否符合需求
expect(snapshot.groups.all).toEqual(/* 预期结果 */);
```

接口测试中，项目让服务器监听端口 `0`，操作系统会自动选择空闲端口，避免测试之间抢占固定端口。

## 9. 推荐的动手练习

每次练习遵循“小改动、先写测试、运行全部检查”的原则。

### 练习一：增加版本接口

目标：增加 `GET /api/tmdb/v1/version`，返回：

```json
{ "name": "jive-tmdb-catalog-lite", "version": "1.0.0" }
```

步骤：

1. 在 `test/http-server.spec.ts` 先增加一个失败测试。
2. 在 `src/http-server.ts` 增加路由。
3. 运行单个测试，直到通过。
4. 思考版本值应该硬编码、从配置注入，还是读取 `package.json`；比较各自代价。

这个练习会让你接触路由、JSON 响应、状态码和接口测试。

### 练习二：给配置增加 `APP_NAME`

目标：允许通过环境变量修改服务名称，并提供默认值。

需要同步修改：

- `src/config.ts` 的类型和 `loadConfig()`。
- `.env.example`。
- `test/config.spec.ts`。
- README 的配置表。

这个练习会让你理解“配置是一种外部输入，也必须校验”。

### 练习三：增加一个 HTTP 错误计数测试

请求不存在的路径，然后请求 `/metrics`，验证错误计数增加。这个练习会让你理解服务器内部状态、
可观测性以及测试之间为什么需要隔离服务器实例。

### 练习四：为 `TmdbClient` 补测试

构造一个假的 `fetch`，分别模拟：

- 成功响应。
- 第一次 503、第二次成功。
- 不可重试的 401。
- 超过 2 MB 的响应。

构造函数已经允许传入 `fetch`，就是为了让网络边界可测试。这是学习异步、重试和测试替身的好练习。

### 练习五：增加一个新 Feed

最后再做这个综合练习。它会同时涉及类型、TMDB 查询、排序规则、刷新周期、HTTP 路由、manifest、
测试和文档。先列出受影响文件，再开始编码；可以对照 `PROJECT_MAP.md` 的修改索引检查遗漏。

## 10. 建议的一周学习顺序

可以按每天 1～2 小时安排：

| 阶段    | 学习内容                           | 完成标志                                      |
| ------- | ---------------------------------- | --------------------------------------------- |
| 第 1 天 | HTTP 方法、URL、状态码、JSON       | 能用 curl 解释四个接口响应                    |
| 第 2 天 | TypeScript 类型、模块、async/await | 能读懂 `types.ts` 和 `main.ts`                |
| 第 3 天 | 原生 Node HTTP                     | 能完整讲出一次 Catalog 请求链路               |
| 第 4 天 | 榜单业务与数组转换                 | 能解释 `normalize`、`dedupe`、`buildSnapshot` |
| 第 5 天 | 缓存、定时任务、失败和降级         | 能讲出上游失败后的降级行为                    |
| 第 6 天 | Vitest 和测试替身                  | 能独立写一个接口测试                          |
| 第 7 天 | 完成版本接口练习                   | 类型检查、测试、Lint 全部通过                 |

之后再学习 Express/Fastify 或 NestJS、数据库、身份认证、消息队列。先用当前小项目掌握一条完整链路，
再引入框架，会更容易分清哪些是 Node/HTTP 原理，哪些只是框架提供的便利写法。

## 11. 每次改代码的固定工作流

```text
明确输入和预期输出
  → 找到对应层和现有测试
  → 先增加或修改测试
  → 做最小实现
  → 运行单个测试
  → 运行完整检查
  → 更新接口/配置/项目地图文档
```

完整检查命令：

```bash
pnpm lint
pnpm format:check
pnpm typecheck
pnpm test
pnpm build
```

遇到问题时不要只问“为什么报错”，按下面四项记录，通常很快能定位：

1. 执行了什么命令或发了什么请求？
2. 预期结果是什么？
3. 实际状态码、响应体、日志或错误堆栈是什么？
4. 请求经过的最后一个正常模块在哪里？

## 12. 学完后应该能回答的问题

- 为什么 HTTP 请求不直接调用 TMDB？
- `live` 和 `ready` 健康检查有什么区别？
- 为什么响应已经提前生成 gzip 和 Brotli？
- 为什么刷新失败仍然可能返回 200？
- `stale` 和完全不可用有什么区别？
- 为什么测试可以用 `StubTmdb` 替换真实网络？
- 为什么状态文件要先写 `.tmp` 再重命名？
- `TRUST_PROXY=true` 为什么只能放在可信反向代理之后？
- 新增环境变量时为什么必须同时更新测试和 `.env.example`？

如果这些问题都能用自己的话解释，并能完成前三个练习，你已经掌握了这个项目最重要的 Node.js
后端知识，可以开始承担小型接口开发。
