# OneTechCloud 云服务器概述与常用运维命令

> 更新日期：2026-10-08  
> 用途：快速了解当前 VPS 架构，以及 Jive Backend 的巡检、发布、备份和故障处理。  
> 依据：原服务器概述、Jive 仓库部署手册、systemd 模板及当前源码（仓库版本 `1.1.1`）。  
> 核验范围：本次**没有 SSH 登录或修改服务器**。部署手册记录的 2026-09-10 验证结果属于历史记录；当前源码和模板不代表线上已经升级到相同版本、启用了监控后台或推荐功能。实际状态以实机检查为准。**MQTT/Mosquitto 尚未部署，不纳入当前架构。**

本文命令供维护人员执行；普通命令默认在服务器运行，标注“开发机”的命令在 Mac / 项目目录运行。首次安装的完整步骤见仓库 `deploy/DEPLOYMENT_RUNBOOK.md`，监控鉴权见 `docs/ADMIN_MONITORING.md`，客户端契约见 `docs/CLIENT_API.md`、`docs/RECOMMENDATION_API.md` 和 `docs/openapi.yaml`。

## 1. 服务器基本信息

| 项目                     | 当前记录                                                                                             |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| 服务商                   | OneTechCloud                                                                                         |
| 地区/线路                | 美国 / AS4837                                                                                        |
| CPU / 内存               | 1 vCPU / 1 GB RAM                                                                                    |
| 硬盘                     | 20 GB SSD                                                                                            |
| 带宽 / 流量              | 曾提供 300 Mbps / 1 TB 每月（以控制台为准）                                                          |
| 网站                     | `hey-rickytse.com`                                                                                   |
| DNS/CDN                  | Cloudflare                                                                                           |
| 部署方式                 | Linux 原生服务，主要使用 `systemd` 管理；Jive 为单 Node.js 进程                                      |
| 操作系统                 | 项目部署手册历史记录：Debian 11 x86_64；当前版本待核实                                               |
| Node.js                  | 项目要求 Node.js 24；手册历史记录为 `/opt/node-v24.20.0`，入口 `/usr/local/bin/node`，当前版本待核实 |
| Jive 线上版本            | 待实机核实；仓库 `package.json` 当前为 `1.1.1`                                                       |
| 公网 IP / SSH 端口及用户 | 连接信息见受控部署记录；不在本概述重复记录                                                           |

**连接方式（Mac 终端）：**

```bash
# 先替换为真实连接信息；不要保留示例值
server_ssh_target='用户名@服务器地址'
server_ssh_port='实际SSH端口'
ssh "$server_ssh_target"                       # SSH 端口为 22 时
ssh -p "$server_ssh_port" "$server_ssh_target"  # 非默认端口
```

**检查系统：**

```bash
cat /etc/os-release   # 系统版本
uptime                # 运行时间、平均负载
nproc                 # CPU 核心数
free -h               # 内存；重点看 available
swapon --show         # Swap
df -h                 # 磁盘使用率
lsblk                 # 磁盘分区
```

## 2. 当前网络架构

```text
             互联网用户
                 │
       Cloudflare（DNS/CDN）
                 │
            VPS 公网 IP
                 │
          TCP 443（HTTPS）
                 │
        Nginx Stream（SNI）
             ┌───┴────┐
             │        │
       网站流量     Xray 流量
             │        │
     127.0.0.1:8443   127.0.0.1:8444
             │        │
       Nginx HTTPS  Xray
             │
    hey-rickytse.com
             ├─ 网站 /                 → /var/www/ricky-lab
             ├─ 既有 API               → 127.0.0.1:8787
             └─ Jive 路由              → 127.0.0.1:3000
                  ├─ TMDB 榜单 / 健康检查
                  ├─ 个性化推荐（是否启用待核实）
                  └─ 只读监控后台（启用及鉴权待核实）

    Jive → TMDB HTTPS；推荐启用时 → 火山方舟 Ark HTTPS
    Jive 状态文件：/var/lib/jive-catalog/（不对外作为静态文件发布）
    PostgreSQL：服务器已有数据库，Jive 不使用
    SSH：服务器远程管理入口
```

- **Nginx Stream**：占用公网 `443`，根据客户端 TLS SNI 将流量转到不同本地服务。
- **网站与 Jive**：经 `8443` 对应的 Nginx HTTPS 服务处理；Jive 由同一站点按路径转发到 `127.0.0.1:3000`，不新增公网监听端口。
- **Xray**：经 `8444` 对应的代理服务处理。
- **Jive Backend**：`jive-catalog.service` 管理 TMDB 榜单和可选的个性化推荐；运行时不依赖 PostgreSQL、Redis、Docker 或第三方 npm 包。推荐依赖方舟配置，默认关闭。
- **PostgreSQL**：提供关系型数据库；Jive 不使用它，其他应用用途、版本及备份仍待核实。
- **注意**：`8443` / `8444` 的真实监听地址需查看配置；建议只对本机开放。不要未经验证直接修改 443 分流配置。

### 端口速查

| 端口   | 用途                       | 备注                                         |
| ------ | -------------------------- | -------------------------------------------- |
| `443`  | Nginx Stream 统一 TLS 入口 | 已知架构                                     |
| `8443` | 网站与 Jive 的 HTTPS 上游  | 项目手册记录为 `127.0.0.1`；当前待核实       |
| `8444` | Xray 上游                  | 项目手册记录为 `127.0.0.1`；当前待核实       |
| `3000` | Jive Node.js HTTP          | 应仅监听 `127.0.0.1`；无需对公网开放         |
| `8787` | 网站既有 API 上游          | 手册历史记录；所属应用待核实                 |
| `8080` | 既有默认站点               | 手册曾记录公网监听；当前状态和业务依赖待核实 |
| `5432` | PostgreSQL 默认端口        | **不代表已验证实际使用**                     |
| `22`   | SSH 默认端口               | 实际端口待确认                               |
| `80`   | HTTP/重定向/证书验证       | 是否启用待确认                               |

```bash
sudo ss -lntp     # 查看所有 TCP 监听端口及进程
sudo ss -lntup    # 查看 TCP/UDP 监听端口及进程
```

## 3. 当前主要服务与管理命令

### 3.1 Nginx（网站 + SNI 分流）

常见配置位置：`/etc/nginx/nginx.conf`、`/etc/nginx/sites-enabled/`、`/etc/nginx/conf.d/`，以实机为准。

```bash
sudo systemctl status nginx --no-pager   # 查看状态
sudo nginx -t                            # 检查配置语法
sudo nginx -T                            # 查看完整配置（可能包含敏感信息）
sudo journalctl -u nginx -n 100 --no-pager # 最近日志
sudo tail -n 100 /var/log/nginx/error.log # 错误日志（常见路径）
sudo systemctl reload nginx             # 修改配置并校验后热加载
```

**修改前先备份；修改后先 `nginx -t`，再 `reload`，最后分别测试网站、Jive 和 Xray。**

项目部署手册记录的 Jive 接入点：

- 站点：`/etc/nginx/sites-available/hey-rickytse.com`，在既有 `127.0.0.1:8443 ssl` server 内 include `snippets/jive-catalog.conf`。
- Jive 路由：`/api/tmdb/`、`/data/tmdb/`、`/health/live`、`/health/ready`、`/api/v1/recommendations/`。
- `/admin/` 及其 API 只有配置鉴权后才能公开；`/metrics` 仅本机访问。
- **备份不要放在 `sites-enabled` 或其他通配 include 目录**：`.bak`、`.old` 也可能被 Nginx 加载。使用 `/root/nginx-disabled/` 等独立目录。
- 不通过 `location /` 将整个 Node 服务公开；保留现有网站和 8787 API 的路由。

### 3.2 Xray（代理服务）

配置文件位置可能为 `/usr/local/etc/xray/config.json` 或 `/etc/xray/config.json`，需实际确认。

```bash
sudo systemctl status xray --no-pager
sudo systemctl cat xray                 # 查看服务启动参数，定位配置文件
sudo journalctl -u xray -n 100 --no-pager
sudo journalctl -u xray -f              # 实时日志，Ctrl+C 退出
xray version                            # 若 xray 已加入 PATH
```

不要因为查看问题而直接重启；代理是否可用还需要通过客户端测试。

### 3.3 PostgreSQL（数据库）

```bash
systemctl list-units 'postgresql*' --all --no-pager # 查看实际实例服务
sudo systemctl status postgresql --no-pager
sudo journalctl -u postgresql -n 100 --no-pager
command -v pg_lsclusters && pg_lsclusters           # Debian/Ubuntu 常见
sudo -u postgres psql -Atqc 'SELECT version();'     # 查看数据库版本
sudo -u postgres psql -Atqc 'SHOW config_file;'     # 当前配置路径
sudo -u postgres psql -Atqc 'SHOW data_directory;'  # 数据目录
sudo -u postgres psql -Atqc 'SHOW port;'            # 数据库端口
sudo -u postgres psql -Atqc 'SHOW listen_addresses;'# 监听地址
```

提示：`postgresql.service` 在部分发行版是聚合服务，显示 `active (exited)` 不一定意味着数据库未运行。**不要手动删除数据库目录或执行重置操作。**

### 3.4 SSH（远程连接）

```bash
who                                     # 当前登录用户
last -n 10                              # 最近登录记录
sudo sshd -t                            # 检查 SSH 配置（若命令可用）
sudo journalctl -u ssh -n 100 --no-pager # Ubuntu/Debian 常见服务名
```

修改 SSH 端口或防火墙前，保留当前会话并确认新会话能登录，以免失联。

### 3.5 Jive Backend（TMDB 榜单 + 可选推荐）

#### 文件、权限与资源

| 项目       | 项目配置 / 运维含义                                                                            |
| ---------- | ---------------------------------------------------------------------------------------------- |
| 服务       | `jive-catalog.service`；运行用户和组为 `jive:jive`                                             |
| 应用       | `/opt/jive-catalog`，`root:root`；包含 `dist`、`package.json`、systemd 模板                    |
| 启动       | `/usr/local/bin/node --max-old-space-size=256 /opt/jive-catalog/dist/apps/catalog/src/main.js` |
| 配置       | `/etc/jive-catalog/env`，`root:jive`、0640；目录 0750；由 systemd 注入，Node 不自动加载 `.env` |
| 数据目录   | `/var/lib/jive-catalog`，`jive:jive`、0750；systemd 允许写入此目录                             |
| 榜单恢复   | `state.json`，应用创建为 0640；保留刷新周期与最近成功快照                                      |
| 监控历史   | `monitoring.json`，应用创建为 0640；默认保留 90 天，按 `Asia/Shanghai` 聚合                    |
| 推荐预算   | `recommendation-budget.json`，应用创建为 0600；独立保存每日调用、Token 与成本预算              |
| 内存限制   | 模板 V8 老生代堆上限 256 MiB，服务 `MemoryMax=320M`、`TasksMax=64`；当前单元需实机核实         |
| 日志与重启 | JSON 日志进 journald；模板 `Restart=on-failure`、`RestartSec=5`                                |

只有一个 Node 进程。256 MiB 是 V8 老生代堆限制，不是整个进程内存上限；进程还有 Buffer、网络和其他内存。1 GB VPS 同时承载 Nginx、Xray、PostgreSQL，应结合整机 `available`、服务内存和 OOM 日志判断容量，不能仅提高 `MemoryMax`。

```bash
sudo systemctl status jive-catalog --no-pager
systemctl is-active jive-catalog
systemctl is-enabled jive-catalog
sudo systemctl cat jive-catalog             # 核对已安装单元；不要公开粘贴敏感配置
sudo systemctl show jive-catalog -p MainPID -p MemoryCurrent -p MemoryMax -p NRestarts
/usr/local/bin/node -v
/usr/local/bin/node -p 'JSON.parse(require("fs").readFileSync("/opt/jive-catalog/package.json","utf8")).version'
sudo ss -lntp | grep ':3000'
sudo journalctl -u jive-catalog -n 100 -l --no-pager
sudo journalctl -u jive-catalog -f           # Ctrl+C 退出
sudo ls -ld /etc/jive-catalog /var/lib/jive-catalog
sudo ls -l /etc/jive-catalog/env /var/lib/jive-catalog/
```

预期：仅 `127.0.0.1:3000`；日志出现 `catalog server listening`。上面的源码版本和文件清单不能证明生产版本，要以服务器输出为准。推荐关闭时预算文件可能尚未创建；没有事件时监控文件也可能尚未生成。

#### 生产配置要点

以下是本服务器链路的配置基线；密钥通过受控编辑器写入 `/etc/jive-catalog/env`，不要直接复制占位符启用服务：

```dotenv
HOST=127.0.0.1
PORT=3000
LOG_LEVEL=info
TRUST_PROXY=false
PUBLIC_RATE_LIMIT_MAX=600
CATALOG_STATE_FILE=/var/lib/jive-catalog/state.json
MONITORING_STATE_FILE=/var/lib/jive-catalog/monitoring.json
MONITORING_RETENTION_DAYS=90
MONITORING_TIMEZONE=Asia/Shanghai
MONITORING_SAVE_INTERVAL_MS=60000
RECOMMENDATION_ENABLED=false
RECOMMENDATION_BUDGET_STATE_FILE=/var/lib/jive-catalog/recommendation-budget.json
RECOMMENDATION_BUDGET_TIMEZONE=Asia/Shanghai
```

- `TMDB_READ_ACCESS_TOKEN` 必填；缺失会导致启动失败。TMDB 并发上限 4，可在资源紧张时调低；修改页数会影响覆盖范围，需验收榜单内容。
- **不要照抄 `.env.example` 中的 `TRUST_PROXY=true` 或 Caddy 注释**。本服务器使用 Nginx Stream，手册记录未传递可信原始客户端 IP，因此使用 `false`。`600` 是该部署手册的限流设置，源码默认是 `120`，都不是已核实的线上值。
- 该链路下 Catalog 公共限流及推荐来源限流可能把所有公网用户视为同一来源。推荐还有独立的主体、来源、并发、队列及预算限制；调整 `PUBLIC_RATE_LIMIT_MAX` 不会调整它们。不要直接给整个 Stream 入口打开 PROXY Protocol，需单独验证与 Xray 的兼容性。
- 模板设 `ADMIN_ENABLED=true`，源码默认 `false`。未配置反向代理鉴权时应保持后台不公开，必要时在环境文件中显式设置 `ADMIN_ENABLED=false`；仅设置 `true` 不提供认证。
- 推荐启用需完整配置 `ARK_API_KEY`、`ARK_BASE_URL`、`ARK_MODEL`、两项每百万 Token 的人民币价格、三个至少 32 字节的签名/指纹密钥，以及可写预算路径。价格必须是显式正数，其他限额详见仓库 `.env.example` 和 `src/config.ts`。
- 密钥、用户历史、匿名主体和 Cursor 不进入普通运维记录。轮换主体签名密钥会使旧匿名主体失效，需让客户端重新签发。

修改 env 后需要重启 Jive 才能生效；仅改 env 不需要 `daemon-reload`。修改 systemd 单元才需要先 `systemd-analyze verify`、再 `daemon-reload` 和重启。重启会中断 Jive 请求，并使内存推荐会话丢失，旧 Cursor 返回 410。

#### 健康与业务验收

```bash
# 服务器本机：用 GET，不要用 curl -I（HEAD）检查 Jive
curl -sS -i --max-time 10 http://127.0.0.1:3000/health/live
curl -sS -i --max-time 10 http://127.0.0.1:3000/health/ready
curl -sS --max-time 10 http://127.0.0.1:3000/api/tmdb/v1/manifest
for feed in latest popular top_rated; do
  curl --compressed -sS --max-time 10 -o /dev/null \
    -w "$feed: %{http_code}, %{size_download} bytes\n" \
    "http://127.0.0.1:3000/api/tmdb/v1/catalog?feed=$feed"
done
curl -sS --max-time 10 http://127.0.0.1:3000/metrics
```

| 检查                             | 解读                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| live 200                         | HTTP 进程存活；不能证明 TMDB、方舟、状态文件或所有业务可用                                                             |
| ready 200 + `status=ok`          | 三个 Feed 都有可用且未 stale 的快照                                                                                    |
| ready 200 + `status=degraded`    | 三个 Feed 可返回，但至少一个已 stale；继续查刷新失败                                                                   |
| ready 503 + `status=unavailable` | 至少一个 Feed 缺失或超过最大保留期；首次无快照启动可能仍在预热                                                         |
| manifest 200                     | 只表示接口成功；缺失 Feed 会被省略，仍需检查三个 Feed                                                                  |
| metrics 200                      | 仅两个进程内计数 `jive_catalog_http_requests_total` / `jive_catalog_http_errors_total`；不是全路由完整统计，重启会清零 |

Catalog 请求读取内存，不会实时请求 TMDB。`/data/tmdb/v1/*.json` 也是动态响应，不能将 `/var/lib/jive-catalog` 配成静态网站目录。

| Feed        | 正常刷新 | 标记 stale | 最大保留 |
| ----------- | -------- | ---------- | -------- |
| `latest`    | 1 天     | 36 小时    | 7 天     |
| `popular`   | 3 天     | 4 天       | 14 天    |
| `top_rated` | 7 天     | 8 天       | 30 天    |

后台串行刷新 Feed，失败后保留最近成功快照；按 5 分钟、15 分钟、1 小时、6 小时封顶退避，成功重置。不要通过频繁重启强行刷新或清空 `state.json`。关注 `catalog refresh completed`、`catalog refresh failed`、`catalog state restored` 和 `catalog state restore failed` 日志。

从 Mac 或其他外部网络验收完整链路：

```bash
curl -sS -i --max-time 10 https://hey-rickytse.com/health/live
curl -sS -i --max-time 10 https://hey-rickytse.com/health/ready
for feed in latest popular top_rated; do
  curl --compressed -sS --max-time 10 -o /dev/null \
    -w "$feed: %{http_code}, %{size_download} bytes\n" \
    "https://hey-rickytse.com/api/tmdb/v1/catalog?feed=$feed"
done
curl -I --max-time 10 https://hey-rickytse.com/   # 仅静态网站使用 HEAD
```

发布后还需确认既有 8787 API 的实际业务路径和 Xray 客户端能正常使用。HTTP 200 之外也应查看 Feed 内容、revision、生成时间及 stale 标志；新鲜榜单验收应为三个 Feed 都 `ok`。

#### 只读监控后台

后台只在打开页面或点击“刷新数据”时读取，无前端定时轮询。查看进程内存、Feed 刷新/重试、TMDB 缓存及推荐预算，历史 HTTP/TMDB/Feed 指标默认保留 90 天。监控状态保存由事件触发并限频，**不是每隔 60 秒必定落盘**；正常退出会尝试保存，异常退出可能丢失最近尚未保存的数据。

本机读取（不经过公网鉴权）：

```bash
curl -sS --max-time 10 'http://127.0.0.1:3000/admin/api/overview?days=7'
curl -sS --max-time 10 'http://127.0.0.1:3000/admin/api/catalog/items?feed=latest&group=all&page=1&pageSize=20'
```

如果需要公网访问，将以下配置放入现有 8443 HTTPS server 使用的 Jive snippet；先按 `docs/ADMIN_MONITORING.md` 建立密码文件，确保 Nginx 工作进程可读：

```nginx
location = /admin {
    return 302 /admin/;
}
location ^~ /admin/ {
    auth_basic "Jive Admin";
    auth_basic_user_file /etc/nginx/.htpasswd-jive;
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto $scheme;
    add_header Cache-Control "no-store" always;
}
```

先 `sudo nginx -t && sudo systemctl reload nginx`，再从外网 GET `/admin/` 及 `/admin/api/overview?days=7`：未带认证应为 401，合法认证应为 200。`/admin` 重定向可以未鉴权，但 `/admin/` 下页面和 API 都必须鉴权。Cloudflare 不应缓存后台、健康检查或推荐接口。`/metrics` 不添加公网代理。

#### 个性化推荐

常用错误码：`RECOMMENDATION_DISABLED` 表示关闭；`RECOMMENDATION_SUBJECT_BUDGET_EXHAUSTED` / `RECOMMENDATION_GLOBAL_BUDGET_EXHAUSTED` 表示每日额度耗尽；`RECOMMENDATION_BUDGET_STATE_UNAVAILABLE` 表示预算文件读取/保存失败，需先修复文件与权限。不要把这些统一当成方舟故障。

推荐状态独立于 Catalog readiness。在后台 overview 查看 `recommendation.enabled`、`recommendation.budget.available` 和预算统计，再做业务验证：

1. 启用时，`POST /api/v1/recommendations/anonymous-subject`，JSON body `{}`，应返回 201；关闭时预期为 503 / `RECOMMENDATION_DISABLED`。
2. 使用返回主体作为 `X-Jive-Anonymous-Subject`，按推荐接口文档发送空 history/library 的 cold start 请求，应返回空候选且不调用 LLM。
3. 需要验证方舟时，在维护窗口用有效偏好做一次小页请求，并核对预算变化。这会实际调用上游并计费；cold start 成功不能证明方舟凭据可用。
4. NDJSON 推荐使用 `Accept: application/x-ndjson`；Nginx 推荐 location 必须保持 `proxy_buffering off`，超时与方舟调用相匹配（部署手册为 30 秒）。HTTP 200 之后仍可能出现 `error` 事件，必须收到 `done` 才算完成；可用 `curl -N` 观察增量返回。

会话、Cursor 响应和推荐缓存仅在内存，重启后旧 Cursor 返回 410，属于预期行为。预算独立落盘，不能通过重启、删除预算文件或恢复旧预算备份绕过每日限额。预算文件损坏/不可写时拒绝新的生成请求；Catalog 可能继续正常。默认按 `Asia/Shanghai` 切日，日期切换后在预算操作时更新。

## 4. 通用服务管理速查

将下方的 `nginx` 换成 `jive-catalog`、`xray` 或实际数据库服务名即可：

| 目的          | 命令                                               |
| ------------- | -------------------------------------------------- |
| 查看状态      | `sudo systemctl status nginx`                      |
| 是否运行      | `systemctl is-active nginx`                        |
| 是否开机自启  | `systemctl is-enabled nginx`                       |
| 查看日志      | `sudo journalctl -u nginx -n 100 --no-pager`       |
| 实时日志      | `sudo journalctl -u nginx -f`                      |
| 查看进程/内存 | `systemctl show nginx -p MainPID -p MemoryCurrent` |
| 启动服务      | `sudo systemctl start nginx`                       |
| 停止服务      | `sudo systemctl stop nginx`                        |
| 重启服务      | `sudo systemctl restart nginx`                     |

**注意：**后三项会改变运行状态，尤其 `stop` / `restart` 可能中断正在使用的业务。

## 5. 日常巡检（全部是查看命令）

```bash
# 资源
uptime
free -h
df -h /

# 运行服务及端口
systemctl list-units --type=service --state=running --no-pager
sudo ss -lntp

# 核心服务
systemctl is-active nginx xray postgresql jive-catalog 2>/dev/null || true
systemctl list-units 'postgresql*' --all --no-pager
sudo systemctl show jive-catalog -p MemoryCurrent -p NRestarts
curl -sS --max-time 10 http://127.0.0.1:3000/health/ready
sudo ls -lh /var/lib/jive-catalog/

# 主机防火墙（按实际安装情况）
sudo ufw status verbose 2>/dev/null || true
sudo nft list ruleset 2>/dev/null || true

# 内核最近是否出现 OOM
sudo journalctl -k -n 100 --no-pager | grep -Ei 'out of memory|oom|killed process' || true
```

从服务器或 Mac 检查网站（这是可达性初步检查，不等于完整业务验收）：

```bash
curl -I --max-time 10 https://hey-rickytse.com/
```

## 6. 常见问题怎么查

| 问题                          | 优先检查                                                                                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| 网站打不开                    | DNS/Cloudflare → `nginx` 状态 → `nginx -t` → `443/8443` 监听 → Nginx 日志                                                                 |
| Xray 连接失败                 | `xray` 状态与日志 → `8444` 监听 → Nginx 443/SNI 分流 → 客户端实际测试                                                                     |
| Jive 启动失败 / 重启循环      | `journalctl -u jive-catalog` → Node 24 和 ExecStart 路径 → `package.json` 与 dist 是否完整 → env 必填项、变量合法性和权限；先查日志再重启 |
| live 200、ready 503           | 读取 body 中的 missing Feed → 首次预热/最大保留期 → 刷新失败、TMDB Token、DNS、出站 HTTPS、系统时间                                       |
| ready 200 但榜单陈旧          | 检查 `status=degraded`、stale、生成时间及后台 consecutiveFailures/retryAfter；200 不表示新鲜                                              |
| 本机 Jive 正常、公网 404/502  | 404 查 8443 server 是否 include Jive snippet、location 路径；502 查监听及 Nginx 上游错误日志                                              |
| Catalog 429                   | 看错误码和 Retry-After；当前代理链路可能共享来源限流，不要直接启用 TRUST_PROXY                                                            |
| 推荐 429/503                  | 区分关闭、主体/来源限流、队列容量、每日预算耗尽和预算文件不可用；看 error.code 与后台预算诊断                                             |
| 推荐流一次性到达 / 中途失败   | 检查 `proxy_buffering off`、Cloudflare 缓存规则、Nginx/方舟超时；检查终止 done/error 事件                                                 |
| 重启后推荐 410                | 内存会话已丢失；客户端保留已提交页并重新建立会话                                                                                          |
| 后台 404 / 401 / 未鉴权可访问 | 404 查 ADMIN_ENABLED 和代理；401 查 Basic Auth；无认证仍返回 200 应立即撤下公网后台路由或补齐鉴权                                         |
| 状态文件未生成 / 保存失败     | 查各 STATE_FILE 是否设定、是否在 systemd 可写目录、jive 权限、磁盘空间及保存失败日志；不要直接删文件                                      |
| Jive OOM / 自动重启           | 查 MemoryCurrent、MemoryMax、NRestarts 和内核 OOM；结合整机资源调整并发/容量，避免一味提高内存限制                                        |
| 数据库连接失败                | PostgreSQL 实例状态 → 端口与监听地址 → 认证配置 → 数据库日志；Jive 不依赖此数据库                                                         |
| 服务器卡顿                    | `uptime`、`free -h`、`df -h`、服务内存及 OOM 日志                                                                                         |
| SSH 登录不了                  | VPS 控制台 → 公网 IP/端口 → 防火墙/安全组 → sshd 配置；不要盲目重启或清空规则                                                             |

## 7. 待完善记录

- [ ] 复核手册中的 Linux、Node.js、SSH 记录，并记录检查日期和负责人
- [ ] Nginx 分流配置所在文件、真实监听地址
- [ ] Xray 配置路径与 systemd 单元名
- [ ] PostgreSQL 版本、实例、其他应用用途及备份方式（Jive 不使用）
- [ ] Cloudflare 的 DNS/代理记录与 HTTPS 证书续期方式
- [ ] Jive 线上版本、已安装单元、内存限制、自启和端口
- [ ] 三个 Feed 的最近生成时间、状态文件恢复及实际写权限
- [ ] `/admin/` 是否启用、公网鉴权和 `/metrics` 暴露检查
- [ ] 推荐是否启用、真实 Endpoint/价格、预算限额和状态文件可用性（不记录密钥）
- [ ] 8080 默认站点、8787 既有 API 的依赖和验收路径
- [ ] 服务器快照、异机备份频率/保留期、最近一次恢复演练
- [ ] 系统安全支持与迁移计划（以当前实机版本及官方支持信息另行核实）

## 8. 发布、升级与回滚

详细首次安装及目录切换命令以仓库 `deploy/DEPLOYMENT_RUNBOOK.md` 为准。该手册中的 `1.0.0` / `1.0.4` 是历史示例，发布时替换为真实版本；当前仓库为 `1.1.1`，不能据此认定服务器运行版本。

### 发布包准备与校验

开发机在仓库根目录执行；`pnpm release` 会运行 lint、格式、类型、测试、构建及打包，同版本产物已存在时拒绝覆盖：

```bash
pnpm install --frozen-lockfile
# 先按发布策略更新 package.json 的语义版本
pnpm release
release_version=$(node -p 'JSON.parse(require("fs").readFileSync("package.json","utf8")).version')
release_archive="jive-catalog-${release_version}.tar.gz"
shasum -a 256 "artifacts/$release_archive"
# 替换为受控记录中的真实连接信息
server_ssh_port='实际SSH端口'
server_ssh_target='用户名@服务器地址'
scp -P "$server_ssh_port" "artifacts/$release_archive" "artifacts/$release_archive.sha256" \
  "$server_ssh_target:/tmp/"
```

服务器上核对实际发布版本，然后验证两份上传文件：

```bash
release_version='1.1.1'       # 示例；替换为本次实际发布版本
release_archive="jive-catalog-${release_version}.tar.gz"
(cd /tmp && sha256sum -c "$release_archive.sha256")
tar -tzf "/tmp/$release_archive"
```

校验必须成功再继续；传输两份文件的 SHA-256 只能检查完整性，不能单独证明发布来源。产物应含 `dist`、`package.json` 和 `deploy/jive-catalog.service`。生产机不用 pnpm、源码或 `node_modules`；不能漏掉声明 ESM 的 `package.json`。

### 升级顺序

1. 确认本机、公网基线和旧版本；核对磁盘剩余空间，完成第 9 节备份。记录旧应用目录、已安装 systemd 单元、配置和 Nginx 备份位置。
2. 解压到 `/opt/jive-catalog.next.*`，校验入口和权限，再按详细手册切换目录。不要直接覆盖正在运行的目录。
3. 对比新旧 systemd 模板和环境变量。模板启用后台时，先明确公网鉴权或在 env 中显式禁用后台；新增推荐功能先保持 `RECOMMENDATION_ENABLED=false`。
4. 只停止/启动 Jive，保留旧应用目录；单元变更先验证再 `daemon-reload`。默认保留三个持久化文件，不能把清理状态作为升级步骤。
5. 若需要改 Nginx，备份放到非 include 目录，`nginx -t` 成功后 reload；保持 443 Stream、8444 Xray 及既有网站 API 的配置。
6. 完成第 3.5 节本机和公网验收；后台要检查未认证 401，推荐启用时做独立业务验收，并测试网站、既有 API 和 Xray。
7. 记录版本、操作时间、操作者、验收结果和回滚路径。稳定后再清理旧包/目录，保留至少一个已验证可用的回滚版本。

**升级影响**：单进程重启会短暂中断 Jive 请求，推荐旧 Cursor 失效；保存的榜单可恢复。Nginx 与 Xray 不随 Jive 升级重启。不要同时升级系统、Node 主版本或修改 Stream 源 IP 传递机制。

### 回滚与配置变更

应用失败时停止 Jive，保留失败目录用于分析，将升级前应用目录切回；恢复升级前实际安装的 systemd 单元。若曾改 env，按差异恢复相容配置，然后验证单元、`daemon-reload`、启动并重复验收。状态 Schema 如不兼容，需要版本专用迁移/回退；仅换旧代码不保证恢复。

**推荐预算不能随应用回滚恢复到旧计数**：优先保留最新预算文件；如旧版本无法读取，先关闭推荐，核对迁移方式后处理，避免重复消耗每日额度。榜单和监控文件恢复也应先保留当前副本。

仅修改 env 后，维护窗口执行：

```bash
sudo systemctl restart jive-catalog
sudo systemctl status jive-catalog --no-pager
curl -sS -i --max-time 10 http://127.0.0.1:3000/health/ready
```

修改已安装的 systemd 单元后执行：

```bash
sudo systemd-analyze verify /etc/systemd/system/jive-catalog.service
# 上条成功且没有指向 Jive 的错误时，再执行下列命令
sudo systemctl daemon-reload
sudo systemctl restart jive-catalog
```

Nginx 回滚恢复修改前配置或撤回新 include，仍先 `nginx -t` 再 reload，不能在检查失败时加载。

## 9. Jive 备份与恢复

### 备份范围

- 程序和版本：发布包、SHA-256、`/opt/jive-catalog`。
- 凭据与配置：`/etc/jive-catalog/env`、实际安装的 systemd 单元。
- 数据：`state.json`、`monitoring.json`、`recommendation-budget.json`，包括配置中另行指定的实际路径。
- 入口：站点、Jive snippet、后台密码文件、Stream 配置；必要时另存 TLS 证书和续期配置。

本机目录备份主要用于快速回滚，不能应对整机丢失。备份包包含 Token 和后台密码摘要，应限制权限并加密传到独立存储。备份频率、保留期及恢复演练责任人需另行落实；本次没有建立备份任务。PostgreSQL 属于其他业务，需另有逻辑备份/恢复方案，不能把复制正在运行的数据库目录当作有效备份。

### 维护窗口的一致性备份示例

以下在服务器 **root shell** 执行，会短暂停止并恢复 Jive。示例使用默认路径；如运行环境改过路径，先调整。确认磁盘足够且服务原本正常后执行；无需停止 Nginx、Xray 或 PostgreSQL。

```bash
(
  set -eu
  umask 077
  backup_dir="/root/jive-backups/$(date +%Y%m%d-%H%M%S)"
  install -d -o root -g root -m 0700 "$backup_dir"
  df -h /
  du -sh /opt/jive-catalog /var/lib/jive-catalog
  systemctl is-active --quiet jive-catalog
  systemctl stop jive-catalog
  trap 'systemctl start jive-catalog' EXIT
  tar -czf "$backup_dir/jive-server.tar.gz" -C / \
    opt/jive-catalog etc/jive-catalog var/lib/jive-catalog \
    etc/systemd/system/jive-catalog.service etc/nginx
  systemctl start jive-catalog
  trap - EXIT
  (cd "$backup_dir" && sha256sum jive-server.tar.gz > jive-server.tar.gz.sha256)
  tar -tzf "$backup_dir/jive-server.tar.gz" > "$backup_dir/contents.txt"
  printf 'Backup: %s\n' "$backup_dir"
)
```

备份后检查服务、ready 和公网业务，并验证生成文件和异机副本。上述归档不保证包含 Nginx symlink 指向的外部证书、Xray、网站内容或 PostgreSQL 数据；它是 **Jive 运维备份，不是整机镜像**。正常退出会尝试保存监控数据，预算在操作时独立持久化；若服务无法正常停下，保留日志并评估备份完整性。

### 恢复顺序

1. 校验备份 SHA-256，先解压到权限受限的临时目录检查内容，记录备份时间、应用版本及状态 Schema；不要直接将整份 `/etc/nginx` 覆盖到运行服务器。
2. 在维护窗口停止 Jive，先备份当前程序、配置和三个状态文件。恢复兼容的程序与实际单元，配置恢复后核对新机路径、Node 版本及凭据。
3. 恢复确有需要的榜单/监控文件，确保 `jive:jive`、0640 和数据目录 0750。预算文件使用 0600；同一天优先保留最新有效预算。只剩较旧备份时先禁用推荐，核对已用额度后再恢复预算，不能直接重新放量。
4. 单元验证后 `daemon-reload` 并启动；Nginx 仅按差异恢复所需片段，验证后 reload。检查本机、公网、后台鉴权及推荐，最后验证网站和 Xray。
5. 记录恢复耗时和丢失的数据范围。文件存在或 JSON 可解析不等于 Schema 相容，必须通过实际启动、日志、业务和预算诊断验证。

> **后续扩展**：ESP32 / IoT 项目的 MQTT（Mosquitto）仍在规划中；实施后再单独建立部署文档并更新本架构图，不应提前写进“已部署服务”。
