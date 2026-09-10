# 直接部署

生产机只需要 Node.js 24、Caddy和构建后的文件，不需要 pnpm 或 Docker。

```bash
sudo useradd --system --home /nonexistent --shell /usr/sbin/nologin jive
sudo install -d -o jive -g jive -m 0750 /opt/jive-catalog /var/lib/jive-catalog
sudo install -d -o root -g jive -m 0750 /etc/jive-catalog
sudo install -o root -g root -m 0644 deploy/jive-catalog.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now jive-catalog
```

将构建后的 `dist` 和根目录 `package.json` 放入 `/opt/jive-catalog`，把生产环境变量写入
`/etc/jive-catalog/env`。环境文件权限建议为 `0640 root:jive`。

systemd 单元默认设置 `CATALOG_STATE_FILE=/var/lib/jive-catalog/state.json`，确保较长刷新周期在
服务重启后仍可延续。`/var/lib/jive-catalog` 由上述命令创建并授权给 `jive` 用户；请勿在生产环境
把该变量覆盖为空值。

Caddy只需反向代理到环回地址：

```caddyfile
api.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

服务本身已经预压缩Catalog响应。Caddy负责TLS、证书续期和公网连接；Node端口不应对公网
开放。
