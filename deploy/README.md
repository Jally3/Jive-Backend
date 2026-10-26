# 部署文档

当前生产形态是 Node.js + systemd，并接入服务器已有的 Nginx Stream / HTTPS 架构，不使用
Docker，也不新增 Caddy。

- 完整首次部署、升级、验证和回滚步骤：[部署运行手册](./DEPLOYMENT_RUNBOOK.md)
- VPS 架构、Jive 日常巡检和备份恢复：[服务器运维概述](./OneTechCloud-VPS-Architecture-Operations-Simple.md)
- systemd 单元模板：[jive-catalog.service](./jive-catalog.service)

生产服务器只需要 Node.js 24、构建后的 `dist`、根目录 `package.json` 和 systemd 单元，不需要
pnpm、TypeScript、源码或 `node_modules`。Node 服务只监听 `127.0.0.1:3000`，公网流量由现有
Nginx 转发。
