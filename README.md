# ZTNet Planet 安全自建版

这是一个以 **ZTNet 为管理核心** 的 ZeroTier 私有 Controller/Planet 发行版。它保留
ZTNet 的网络管理能力，并新增隔离的宿主机配置代理、HTTPS 管理入口、安全暴露面页面、
可选的加固 TCP fallback relay、迁移与备份工具。

> 面向个人、非商业自建。部署前请确认 ZeroTier 和 ZTNet 当前许可证符合你的用途。

## 固定组件

- ZeroTier One `1.16.2`，commit `fc5c3ec22090b5b2a0f274e863651fe9ca489bf4`，以
  `ZT_CONTROLLER=1` 构建；
- ZTNet commit `19206f20917de5e75c3f378c732e275f0a3b16ae`，源代码位于
  `services/ztnet`；
- PostgreSQL 17 Alpine、Caddy 2.11.4、本项目 Rust TCP fallback relay。

个人使用 SQLite 在容量上通常足够，但 ZTNet 的 Prisma schema、迁移、备份和并发行为都以
PostgreSQL 为正式路径；强行改成 SQLite 会形成长期兼容分支。因此这里使用限制为 50 个连接、
128 MiB shared buffers 的轻量 PostgreSQL，而不改写 ZTNet 数据层。

源码提交和基础镜像 digest 均固定。升级方法见 [UPSTREAM.md](UPSTREAM.md)。

## 默认安全状态

- 管理端仅监听 `https://127.0.0.1:3443`，自动生成自签名证书；
- ZTNet 原始端口仅绑定 `127.0.0.1:3000`；
- ZeroTier 根节点开放 `UDP/9993`；
- Controller API 仅容器内部可见；
- TCP fallback relay 和经 ZeroTier 虚拟网访问管理端均默认关闭；
- 第一个注册账户成为管理员，随后开放注册自动关闭；
- 密码至少 14 位，bcrypt cost 12，默认失败 5 次锁定 15 分钟，会话最长 8 小时。

公网绑定、HTTP、直接暴露 Controller API、任意来源 relay 都允许由用户选择，但界面会显示
高风险警告、要求管理员重新输入密码，并记录安全审计事件。

## 1Panel 只粘贴 Compose 部署

对外只需交付 [`docs/PRODUCTION-DEPLOYMENT.md`](docs/PRODUCTION-DEPLOYMENT.md) 这一份中文
文档。文档已经内嵌完整 Compose、秘密值生成、访问、备份、升级和新旧机迁移命令；部署者
不需要访问本私有 GitHub 仓库、下载源码或索取其他文件。`docker-compose.1panel.yml` 是
仓库内受门禁校验的同源副本，不是部署者必须取得的第二个交付物。

在 VPS 终端生成两个不同的随机值：

```bash
openssl rand -hex 32
openssl rand -hex 48
```

在 1Panel 的“容器 → 编排 → 创建编排”中把名称设为 `ztplanet`，粘贴完整 Compose，
并在环境变量区填写：

```env
ZTPLANET_DB_PASSWORD=第一条随机值
ZTPLANET_AUTH_SECRET=第二条随机值
```

启动后从本机建立 SSH 隧道：

```bash
ssh -N -L 3443:127.0.0.1:3443 管理用户@VPS公网IP
```

浏览器访问 `https://localhost:3443`，接受本实例自签名证书并注册首个管理员。管理端默认
仅绑定回环地址，ZeroTier 默认开放 `UDP/9993`，TCP fallback relay 默认关闭。

旧版 `myztplanet` 必须先核验并停止，同时备份其映射到 `/var/lib/zerotier-one` 和
`/app/dist` 的两个真实宿主机目录，再分别导入 Controller 与 Planet 命名卷。旧容器和原
目录在验收前不得删除。

只使用 Compose 的完整步骤、环境变量、内网/公网绑定、relay 开启方法及原机/跨机迁移命令
都在上述单一交付文档中，文档不假设部署者拥有源码。

仓库根目录的 `docker-compose.yml` 只供需要受限宿主机配置代理的高级安装使用；它不能
脱离源码和 `/etc/ztplanet` 单独粘贴。源码构建定义位于 `docker-compose.build.yml`。

## 功能边界

ZTNet 管理网络、成员、IPv4/IPv6 地址池、路由、DNS、Multicast、Flow Rules、Tags、
Capabilities、组织、用户、API Token、Webhook、成员路径和版本。

新增系统页面管理多个监听 IP/端口/TLS/CIDR、虚拟网访问、UDP 主辅端口、UPnP/NAT-PMP、
Controller 暴露方式、relay 服务端与客户端策略和全部限额；还能查看实际监听、配置漂移、
relay 指标和审计，生成/安装证书、轮换 Controller Token、导出客户端 `local.conf`，以及
预览、原子应用和回滚配置。

## UDP RELAY 与 TCP TUNNELED

- 打洞失败但 UDP 可达根节点时，可经根节点 UDP 转发，CLI 显示 `RELAY`；
- UDP 完全不可用时，启用 fallback 的客户端约 60 秒后走 TCP，显示 `TUNNELED`；
- TCP relay 不固定为 443；443 只是穿越严格防火墙时的建议值；
- 开启服务端 relay 不会自动修改客户端，必须部署页面导出的客户端配置；
- fallback 外层是伪 TLS framing，不是真 TLS，也没有协议级客户端认证；ZeroTier overlay
  数据仍为端到端加密。

relay 阻止回环、私网、链路本地、CGNAT、组播、广播、云元数据及保留地址，只接受来自该
连接已访问目标且未超过请求响应字节额度的回包，并同时限制上下行速率。容器没有
Controller token、identity、数据库、Docker Socket 或管理网络访问，并启用非 root、只读
根文件系统、capability 清零、seccomp、资源限制及第二层宿主机 egress 防火墙。ZTNet 对
Controller 状态卷只有只读访问，Planet 工作文件使用独立可写卷。

审计结论见 [docs/SECURITY-AUDIT.md](docs/SECURITY-AUDIT.md)，漏洞报告见
[SECURITY.md](SECURITY.md)。
