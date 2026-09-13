# Jive Catalog 部署运行手册

本文档记录 2026-09-10 实际验证过的部署形态，供首次部署、后续发布、故障排查和服务器迁移使用。
文档包含服务器公网地址和 SSH 端口，但不包含 SSH 凭证、TMDB Token、TLS 私钥或 Xray 密钥。

服务器连接信息：

```text
地址：38.244.13.162
SSH 用户：root
SSH 端口：43593
```

登录命令：

```bash
ssh -p 43593 root@38.244.13.162
```

## 1. 当前架构

```text
公网客户端
    │ HTTPS :443
    ▼
Nginx Stream（ssl_preread，按 SNI 分流）
    ├─ hey-rickytse.com / www.hey-rickytse.com
    │       └─ 127.0.0.1:8443（Nginx HTTPS）
    │              ├─ /                         → /var/www/ricky-lab
    │              ├─ 既有 API                  → 127.0.0.1:8787
    │              ├─ /api/tmdb/、/data/tmdb/   → 127.0.0.1:3000
    │              └─ /health/live、/health/ready → 127.0.0.1:3000
    └─ xlj.913168.xyz
            └─ 127.0.0.1:8444（Xray VLESS + TLS + Vision）

Jive Catalog（systemd）
    ├─ 程序：/opt/jive-catalog
    ├─ 配置：/etc/jive-catalog/env
    ├─ 状态：/var/lib/jive-catalog/state.json
    └─ 监听：127.0.0.1:3000
```

设计原则：

- 公网 443 继续由现有 Nginx Stream 独占，不安装 Caddy。
- Jive 不监听公网地址，不能绕过 Nginx 直接访问。
- 网站、Xray 和 Jive 使用不同的本地端口，互不抢占。
- 程序、配置和运行数据分别存放，便于权限控制和升级回滚。

## 2. 当前已验证状态

首次部署时已经验证：

- Node.js 24.20.0 安装在 `/opt/node-v24.20.0`。
- `/usr/local/bin/node` 指向该版本。
- `jive-catalog.service` 已启用并处于 `active (running)`。
- Node 只监听 `127.0.0.1:3000`。
- `/health/live` 返回 HTTP 200。
- `/health/ready` 返回 HTTP 200，三个 Feed 均为 `ok`。
- Nginx 配置通过 `nginx -t`。
- `sites-enabled` 中误加载的 `.bak` 已移走，重复 `server_name` 警告消失。

公网代理配置和公网接口仍应按本文第 8、9 节逐项验证，不能仅凭本地健康检查认定发布完成。

## 3. 已知环境与风险

### Debian 11 生命周期

当前服务器为 Debian 11 x86_64。Debian 11 免费 LTS 已于 2026-08-31 结束，系统不会停机或
自动收费，但后续安全漏洞不再保证获得免费修复。短期可继续运行，长期建议通过新服务器迁移到
Debian 13；不要在承载网站和 Xray 的机器上无控制台保障地直接跨版本升级。

### 客户端 IP 与限流

当前 Stream 层没有配置 PROXY Protocol，原始客户端 IP 到达 8443 时很可能已经丢失。生产环境暂用：

```env
TRUST_PROXY=false
PUBLIC_RATE_LIMIT_MAX=600
```

这能避免信任用户伪造的 `X-Forwarded-For`，但应用限流会把 Nginx 当作同一个客户端。若以后需要精确
按用户 IP 限流，应单独设计 Cloudflare 可信来源或只对网站链路启用的源地址传递方案，不能直接给
整个 Stream server 开启 `proxy_protocol`，否则可能破坏 Xray 8444。

### 其他待办

- 默认站点仍在公网监听 8080，确认无业务依赖后再单独关闭。
- `xray.service` 使用特殊用户 `nobody`，`systemd-analyze verify` 会提示安全警告；这不是 Jive
  错误，应在独立维护窗口为 Xray 建立专用用户，不要在发布 Jive 时顺带修改。
- Nginx 全局仍允许旧 TLS 协议，安全加固应作为单独变更验证，避免同时影响网站和 Xray。

## 4. 文件与权限

| 路径                                       | 所有者/权限            | 用途                  |
| ------------------------------------------ | ---------------------- | --------------------- |
| `/opt/jive-catalog`                        | `root:root`，目录 0755 | 只读应用产物          |
| `/etc/jive-catalog`                        | `root:jive`，目录 0750 | 生产配置目录          |
| `/etc/jive-catalog/env`                    | `root:jive`，0640      | 环境变量和 TMDB Token |
| `/var/lib/jive-catalog`                    | `jive:jive`，0750      | 可写运行状态目录      |
| `/var/lib/jive-catalog/state.json`         | 由应用创建，0640       | 重启恢复快照          |
| `/etc/systemd/system/jive-catalog.service` | `root:root`，0644      | systemd 单元          |
| `/etc/nginx/snippets/jive-catalog.conf`    | `root:root`，0644      | Jive 公网反向代理     |

`jive` 是无登录 shell、无有效 home 的系统用户。应用不以 root 身份运行，也不能修改自己的程序或
配置，只能写状态目录。

## 5. 发布前构建

开发机要求 Node.js 24 和 pnpm 10。在仓库根目录安装依赖：

```bash
pnpm install --frozen-lockfile
```

更新 `package.json` 中的语义版本后执行统一发布命令：

```bash
pnpm release
```

该命令依次执行 lint、格式、类型、测试和构建检查，然后在 `artifacts/` 生成版本化压缩包及同名
`.sha256` 文件。同一版本的压缩包已存在时会拒绝覆盖，必须先确认版本号是否应该递增。

发布包没有原生扩展和生产 npm 依赖，因此不上传 `node_modules`，服务器也不需要 pnpm。`package.json`
必须随 `dist` 上传，因为其中的 `"type": "module"` 决定 Node 按 ESM 方式加载 `.js`。

## 6. 上传与完整性验证

开发机上传：

```bash
scp -P 43593 \
  artifacts/jive-catalog-1.0.4.tar.gz \
  root@38.244.13.162:/tmp/
```

注意：`scp` 使用大写 `-P`，`ssh` 使用小写 `-p`。

服务器验证：

```bash
ssh -p 43593 root@38.244.13.162
sha256sum /tmp/jive-catalog-1.0.4.tar.gz
```

服务器输出必须与开发机的 SHA-256 完全一致。SHA-256 用来发现传输损坏；正式供应链还可以增加发布
签名，因为单独的校验值不能证明发布者身份。

## 7. 首次安装

### 7.1 Node.js

使用经过 SHA-256 或签名验证的 Node.js 24 官方 Linux x64 二进制，安装到版本化目录：

```text
/opt/node-v24.20.0
```

再建立稳定入口：

```bash
ln -sfn /opt/node-v24.20.0/bin/node /usr/local/bin/node
```

验证：

```bash
/usr/local/bin/node -v
```

不要使用 root 个人目录下的 nvm 路径作为 systemd 生产入口。

### 7.2 用户、目录和应用

```bash
id jive || useradd \
  --system \
  --home /nonexistent \
  --shell /usr/sbin/nologin \
  jive

install -d -o root -g root -m 0755 /opt/jive-catalog
install -d -o jive -g jive -m 0750 /var/lib/jive-catalog
install -d -o root -g jive -m 0750 /etc/jive-catalog

tar -xzf /tmp/jive-catalog-1.0.0.tar.gz \
  -C /opt/jive-catalog

chown -R root:root /opt/jive-catalog
```

### 7.3 生产环境变量

```bash
touch /etc/jive-catalog/env
chown root:jive /etc/jive-catalog/env
chmod 0640 /etc/jive-catalog/env
```

通过受控编辑器填写，禁止提交到 Git 或粘贴到聊天：

```env
PORT=3000
HOST=127.0.0.1
LOG_LEVEL=info

TMDB_READ_ACCESS_TOKEN=REPLACE_WITH_SECRET
TMDB_API_BASE_URL=https://api.themoviedb.org/3
TMDB_CONCURRENCY=4
TMDB_PAGES=5
TMDB_REQUEST_TIMEOUT_MS=10000

PUBLIC_RATE_LIMIT_MAX=600
TRUST_PROXY=false

CATALOG_STATE_FILE=/var/lib/jive-catalog/state.json
```

### 7.4 systemd

```bash
install -o root -g root -m 0644 \
  /opt/jive-catalog/deploy/jive-catalog.service \
  /etc/systemd/system/jive-catalog.service

systemd-analyze verify /etc/systemd/system/jive-catalog.service
systemctl daemon-reload
systemctl enable --now jive-catalog
```

`systemd-analyze verify` 可能同时报告现有 `xray.service` 的 `nobody` 警告；只要没有指向
`jive-catalog.service` 的错误，就不影响 Jive 启动。

## 8. Nginx 接入

### 8.1 现有配置位置

```text
/etc/nginx/nginx.conf
/etc/nginx/sites-available/hey-rickytse.com
/etc/nginx/sites-enabled/hey-rickytse.com
/etc/nginx/snippets/ricky-lab-api.conf
/etc/nginx/snippets/ricky-files.conf
```

不要把 `.bak` 文件放在 `sites-enabled`。主配置使用 `include /etc/nginx/sites-enabled/*;`，所以任何
扩展名都会被加载。备份应放在 `/root/nginx-disabled` 或其他不被 include 的目录。

### 8.2 Jive snippet

创建 `/etc/nginx/snippets/jive-catalog.conf`：

```nginx
location ^~ /api/tmdb/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Connection "";
    proxy_connect_timeout 3s;
    proxy_read_timeout 20s;
    proxy_send_timeout 20s;
}

location ^~ /data/tmdb/ {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
    proxy_set_header Connection "";
    proxy_connect_timeout 3s;
    proxy_read_timeout 20s;
    proxy_send_timeout 20s;
}

location = /health/live {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}

location = /health/ready {
    proxy_pass http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-Proto https;
}
```

没有代理 `/metrics`；它只应从服务器本机访问。

在 `/etc/nginx/sites-available/hey-rickytse.com` 的现有 server 内加入：

```nginx
include snippets/jive-catalog.conf;
```

加入后的开头应类似：

```nginx
server {
    include snippets/ricky-lab-api.conf;
    include snippets/ricky-files.conf;
    include snippets/jive-catalog.conf;

    listen 127.0.0.1:8443 ssl;
    server_name hey-rickytse.com www.hey-rickytse.com;
```

修改前将文件复制到 `/root/nginx-disabled`。修改后必须先验证再平滑加载：

```bash
nginx -t && systemctl reload nginx
```

不要用 restart 代替 reload；公网 443 同时承载网站和 Xray，reload 能让已有连接尽量平滑完成。

## 9. 发布验证

### 9.1 本机服务

```bash
systemctl status jive-catalog --no-pager
ss -lntp | grep ':3000'
curl -i http://127.0.0.1:3000/health/live
curl -i http://127.0.0.1:3000/health/ready
ls -lh /var/lib/jive-catalog/state.json
```

验收要求：

- systemd 为 `active (running)`。
- 只出现 `127.0.0.1:3000`，不能出现 `0.0.0.0:3000`。
- live 返回 200。
- 首次预热完成后 ready 返回 200，三个 Feed 都是 `ok`。
- 状态文件已经生成且不为空。

### 9.2 三个 Feed

```bash
for feed in latest popular top_rated; do
  curl --compressed -sS -o /dev/null \
    -w "$feed: %{http_code}, %{size_download} bytes\n" \
    "http://127.0.0.1:3000/api/tmdb/v1/catalog?feed=$feed"
done
```

三个状态都应为 200。

### 9.3 公网

```bash
curl -i https://hey-rickytse.com/health/live
curl -i https://hey-rickytse.com/health/ready

curl --compressed -sS -o /dev/null \
  -w 'popular: %{http_code}, %{size_download} bytes\n' \
  'https://hey-rickytse.com/api/tmdb/v1/catalog?feed=popular'

curl -I https://hey-rickytse.com/
```

不要用 `curl -I` 测试 Jive API，因为它发送 HEAD，而服务只允许 GET。最后一条只用于确认原静态网站。

同时验证 Xray 客户端仍能建立连接。只有网站、Jive 和 Xray 都正常，才算发布完成。

## 10. 日常运维

```bash
# 状态
systemctl status jive-catalog --no-pager

# 最近 100 行完整日志
journalctl -u jive-catalog -n 100 -l --no-pager

# 实时日志
journalctl -u jive-catalog -f

# 本机指标
curl http://127.0.0.1:3000/metrics

# 状态文件
ls -lh /var/lib/jive-catalog/state.json

# 配置检查
nginx -t
```

日志为一行一个 JSON。重点关注：

- `catalog refresh completed`：刷新成功、条目数和耗时。
- `catalog refresh failed`：错误、连续失败次数和下次重试延迟。
- `catalog state restored`：重启后成功恢复状态。
- `request failed`：HTTP 层未预期错误。

刷新周期：

| Feed        | 刷新 | 标记 stale | 最大保留 |
| ----------- | ---: | ---------: | -------: |
| `latest`    | 1 天 |    36 小时 |     7 天 |
| `popular`   | 3 天 |       4 天 |    14 天 |
| `top_rated` | 7 天 |       8 天 |    30 天 |

连续失败按 5 分钟、15 分钟、1 小时、6 小时封顶退避；成功后重置。

## 11. 后续版本升级

升级前必须确认新版本通过全部检查，并保留当前应用目录。以下流程会产生短暂的 Node 服务重启，
不重启 Nginx 和 Xray：

```bash
release_archive=/tmp/jive-catalog-1.0.4.tar.gz
next_dir=$(mktemp -d /opt/jive-catalog.next.XXXXXX)
backup_dir=/opt/jive-catalog.backup-$(date +%Y%m%d-%H%M%S)

tar -xzf "$release_archive" -C "$next_dir"
chown -R root:root "$next_dir"
chmod 0755 "$next_dir"

/usr/local/bin/node --check \
  "$next_dir/dist/apps/catalog/src/main.js"

systemctl stop jive-catalog
mv /opt/jive-catalog "$backup_dir"
mv "$next_dir" /opt/jive-catalog

install -o root -g root -m 0644 \
  /opt/jive-catalog/deploy/jive-catalog.service \
  /etc/systemd/system/jive-catalog.service

systemctl daemon-reload
systemctl start jive-catalog
```

默认保留 `/var/lib/jive-catalog/state.json` 和 `monitoring.json`。只有发布说明明确指出持久化 Schema
不兼容时，才单独备份并移走对应状态文件；不能把清理状态作为常规升级步骤。启动后立即执行第 9 节
所有本机检查。

确认新版本稳定后再清理旧备份；不要在刚发布后立刻删除回滚目录。

## 12. 回滚

### 应用回滚

如果新版本失败：

```bash
failed_dir=/opt/jive-catalog.failed-$(date +%Y%m%d-%H%M%S)

systemctl stop jive-catalog
mv /opt/jive-catalog "$failed_dir"
mv /opt/jive-catalog.backup-YYYYMMDD-HHMMSS /opt/jive-catalog

install -o root -g root -m 0644 \
  /opt/jive-catalog/deploy/jive-catalog.service \
  /etc/systemd/system/jive-catalog.service

systemctl daemon-reload
systemctl start jive-catalog

systemctl status jive-catalog --no-pager
curl -i http://127.0.0.1:3000/health/ready
```

将 `YYYYMMDD-HHMMSS` 替换为实际备份目录名；版本号也应替换为本次发布版本。如果本次发布曾按发布
说明迁移持久化 Schema，还必须执行该版本专用的数据回滚步骤。

### Nginx 回滚

如果只新增了 Jive include，可以先注释或删除：

```nginx
include snippets/jive-catalog.conf;
```

或者恢复修改前备份，然后：

```bash
nginx -t && systemctl reload nginx
```

如果 `nginx -t` 失败，绝不执行 reload。

## 13. 常见故障

### systemd 启动失败

```bash
journalctl -u jive-catalog -n 100 -l --no-pager
grep ExecStart /etc/systemd/system/jive-catalog.service
ls -l /usr/local/bin/node
ls -l /opt/jive-catalog/dist/apps/catalog/src/main.js
```

重点检查 Node 路径、环境文件、Token 和文件权限。

### live 200、ready 503

说明进程活着，但至少一个 Feed 缺失。首次启动可能仍在预热；持续 503 时查看刷新失败日志、TMDB
Token、DNS、出站 HTTPS 和系统时间。

### 本机 200、公网 404

说明 Node 正常，检查 `jive-catalog.conf` 是否被正式 8443 server include，以及 location 路径是否正确。

### 本机 200、公网 502

说明 Nginx 路由已经命中，但无法连接 Node。检查 systemd 状态和 `127.0.0.1:3000` 监听。

### `conflicting server name`

检查 `sites-enabled` 是否混入 `.bak`、`.old` 等备份。该目录的所有文件都会被加载，备份必须移出。

### 状态文件未生成

```bash
grep CATALOG_STATE_FILE /etc/jive-catalog/env
ls -ld /var/lib/jive-catalog
journalctl -u jive-catalog -n 100 -l --no-pager
```

目录应允许 `jive` 用户写入，环境变量不能留空。

## 14. 安全底线

- 不在仓库、聊天、shell 历史或普通日志中保存 Token 和私钥。
- `/etc/jive-catalog/env` 保持 `0640 root:jive`。
- Node 只监听 `127.0.0.1`，防火墙不开放 3000、8443、8444。
- Nginx 修改前备份，修改后先 `nginx -t`，再 reload。
- 不在一次发布中同时修改 Jive、Xray、Stream 分流和系统版本。
- 服务器迁移时保留旧服务器至少 3～7 天，验证后再下线。
- Debian 11 只作为过渡环境，规划迁移到仍受安全支持的 Debian 版本。
