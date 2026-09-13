# 后台监控部署与使用

## 数据行为

后台页面不会定时轮询。打开 `/admin/` 时读取一次数据，之后仅在点击“刷新数据”时调用
`/admin/api/overview`。

服务会在实际事件发生时聚合以下长期数据：

- 标准化 HTTP 路由的每日调用次数、首次/最近调用时间、状态码、耗时和响应流量；
- TMDB 标准化端点的每日调用、网络尝试、失败、超时、429 和重试；
- TMDB Detail Cache 每日命中、未命中、失败缓存命中、过期和在途合并；
- 各 Feed 每日刷新次数、成功、失败、耗时、最后条目数和编码大小；
- 最近 100 条 Catalog 刷新事件。

进程内存、运行时间、当前 TMDB Cache、并发队列、Feed revision、stale 状态和 JSON 编码大小只在
手动读取时计算，不写入历史曲线。

持久化没有后台定时器。首次变化会保存；之后只有距离上次保存超过配置间隔且再次发生事件、手动读取
后台、或者服务正常退出时才会保存。异常断电可能损失上次保存后的少量数据。

## 应用配置

```dotenv
ADMIN_ENABLED=true
MONITORING_STATE_FILE=/var/lib/jive-catalog/monitoring.json
MONITORING_RETENTION_DAYS=90
MONITORING_TIMEZONE=Asia/Shanghai
MONITORING_SAVE_INTERVAL_MS=60000
```

`ADMIN_ENABLED` 只控制路由是否存在，不承担身份认证。应用应继续只监听环回地址。

## Nginx 鉴权

后台路由必须在公网反向代理层增加身份认证。下面是 Basic Auth 示例：

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

部署前创建密码文件，并确保只有 root 和 Nginx 工作进程能够读取。修改配置后先执行 `nginx -t`，
验证成功后再平滑加载 Nginx。

不要通过通配 `location /` 将整个 Node 服务公开；`/metrics` 仍应只允许服务器本机访问。

## 只读接口

```http
GET /admin/api/overview?days=30
GET /admin/api/catalog/items?feed=latest&group=all&page=1&pageSize=20
```

`days` 限制为 1～90；`pageSize` 限制为 1～100。Catalog 内容接口只允许访问三个已知 Feed 和五个
已知分组，不接受文件路径，因此不能用于读取服务器上的任意 JSON 文件。

## 故障处理

- 未配置 `MONITORING_STATE_FILE` 时后台仍可工作，但重启后历史数据清零。
- 文件不存在时会自动从空状态开始。
- 文件损坏或 Schema 不兼容时，Catalog 服务仍会启动，并在日志和后台最近事件中记录恢复失败。
- 保存使用同目录临时文件加原子重命名，systemd 的 `/var/lib/jive-catalog` 写权限可直接复用。
