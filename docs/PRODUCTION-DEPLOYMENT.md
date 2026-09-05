# 只使用 Compose 内容在 1Panel 部署和迁移

本文只假设部署者拿到一份 `docker-compose.1panel.yml` 的文本内容。部署者不需要下载
GitHub 源码、不需要执行本项目脚本，也不需要在宿主机创建 Caddyfile、证书或配置代理。
适用于 Linux AMD64、ARM64 VPS 和 1Panel 的“容器 → 编排”。

不要把仓库根目录的 `docker-compose.yml` 单独交给别人。该文件属于带宿主机安全配置代理
的高级安装模式，依赖 `/etc/ztplanet` 和 Unix Socket，不是可独立粘贴的 Compose。

## 一、交付给部署者的内容

只需要把 `docker-compose.1panel.yml` 的完整内容交给部署者。该 Compose 已经包含：

- 五个经过双架构安全门禁的 Docker Hub 镜像及不可变清单摘要；
- PostgreSQL、ZeroTier Controller/Planet、ZTNet 和自签名 HTTPS 管理入口；
- 命名卷、内部网络、健康检查、只读文件系统、能力限制和资源限制；
- 默认关闭的 TCP fallback relay；
- 内嵌 Caddy 配置，不依赖宿主机文件。

部署者只需要自行生成两个秘密值。秘密值不能由发布者预先写进公共 Compose，否则所有
安装实例将共享相同数据库密码和登录加密密钥。

## 二、部署前检查

在 1Panel 主机终端执行：

```bash
uname -m
docker version
docker compose version
test -c /dev/net/tun && echo TUN正常
```

要求：

- 架构是 `x86_64`、`aarch64` 或 `arm64`；
- Docker Compose 不低于 2.24.4；
- `/dev/net/tun` 存在；
- 云安全组默认只放行可信来源的 SSH 和 `UDP/9993`；
- 不要在公网放行 TCP/3443，除非部署者明确决定公开管理端。

生成两个不同的随机秘密值：

```bash
openssl rand -hex 32
openssl rand -hex 48
```

第一行用于 `ZTPLANET_DB_PASSWORD`，第二行用于 `ZTPLANET_AUTH_SECRET`。只保存到部署者
自己的密码管理器和 1Panel 编排环境变量中，不要发回发布者、聊天或工单。

## 三、在 1Panel 粘贴部署

进入 **容器 → 编排 → 创建编排**：

1. 编排名称填写 `ztplanet`，不要使用其他名称；
2. 创建方式选择“编辑”或“粘贴 Compose 内容”；
3. 粘贴 `docker-compose.1panel.yml` 的全部内容；
4. 在编排的环境变量区域填写：

```env
ZTPLANET_DB_PASSWORD=第一条随机值
ZTPLANET_AUTH_SECRET=第二条随机值
```

5. 保存并启动编排。

不要把两个秘密值直接替换进 Compose 正文。Compose 中的 `${...}` 是变量引用，不是要求
删除的占位符。缺少秘密值时编排会主动报错并拒绝启动，避免使用默认密码。

正常启动后应看到：

- `postgres`：健康；
- `zerotier`：健康；
- `ztnet`：健康；
- `gateway-init`：正常退出，退出码 0；
- `gateway`：运行中；
- `relay`：默认不会创建或运行。

`gateway-init` 是一次性权限初始化任务，成功后显示“已退出”是正常状态，不是故障。

## 四、默认访问方法

默认管理入口只绑定 VPS 的 `127.0.0.1:3443`。在部署者自己的电脑执行：

```bash
ssh -N -L 3443:127.0.0.1:3443 管理用户@VPS公网IP
```

保持 SSH 窗口运行，浏览器访问：

```text
https://localhost:3443
```

Caddy 会自动创建并持久化本实例独有的内部 CA 和自签名证书。首次访问出现证书警告属于
预期现象。第一个注册账户成为管理员，随后公开注册自动关闭；密码至少 14 位。

如果页面打不开，先在 VPS 检查：

```bash
docker ps --filter label=com.docker.compose.project=ztplanet
ss -lntup | grep 3443
```

在 1Panel 中查看 `gateway` 和 `ztnet` 日志。不要为了排错直接把 3443 改成公网监听。

## 五、管理端绑定内网或指定地址

这些值都在 1Panel 编排“环境变量”中设置，然后重建编排：

| 变量 | 默认值 | 作用 |
|---|---|---|
| `MANAGEMENT_BIND_ADDRESS` | `127.0.0.1` | 宿主机实际绑定地址 |
| `MANAGEMENT_HOST` | `localhost` | HTTPS 证书名称和 ZTNet 标准访问地址 |
| `MANAGEMENT_PORT` | `3443` | 宿主机公开的管理端 TCP 端口 |

例如只允许通过 VPS 的内网地址 `192.168.10.20` 访问：

```env
MANAGEMENT_BIND_ADDRESS=192.168.10.20
MANAGEMENT_HOST=192.168.10.20
MANAGEMENT_PORT=3443
```

`MANAGEMENT_BIND_ADDRESS=0.0.0.0` 会包含公网、内网及可能存在的 ZeroTier 接口。Compose
不会禁止部署者这样做，但必须同时使用云安全组限制来源，并明确承担公网管理面的风险。
如果使用域名，把 `MANAGEMENT_HOST` 设置为该域名；本 Compose 默认仍使用内部自签名证书，
不会自动申请公网 ACME 证书。

## 六、ZeroTier UDP 端口

可在 1Panel 环境变量中设置：

```env
ZT_BIND_ADDRESS=0.0.0.0
ZT_PUBLIC_PORT=9993
```

云安全组需要放行相同的 UDP 端口。修改外部端口或公网 IP 后，需要重新生成并向客户端
分发 Planet/Moon；只改 Docker 端口不会自动更新已经安装在客户端上的 Planet 文件。

## 七、可选 TCP fallback relay

relay 默认关闭。只有 UDP 在运营商网络中完全不可用并且部署者确实需要 `TUNNELED` 模式
时才开启。

在 1Panel 编排环境变量中添加：

```env
COMPOSE_PROFILES=relay
RELAY_BIND_ADDRESS=0.0.0.0
RELAY_PUBLIC_PORT=443
RELAY_ALLOWED_CIDRS=可信公网地址/32
```

443 不是固定端口，可以改为 8443、9443 等任意未占用 TCP 端口。若 1Panel 版本不传递
`COMPOSE_PROFILES`，可删除 Compose 中 relay 服务的 `profiles: ["relay"]` 一行后重建。

`RELAY_ALLOWED_CIDRS` 留空代表允许任意来源。TCP fallback 协议外层不是真 TLS，也没有
协议级客户端认证，公网开放时应优先设置来源 CIDR、较低连接上限和云防火墙限速。

服务端启动 relay 不会自动修改客户端。客户端仍需配置：

```json
{
  "settings": {
    "tcpFallbackRelay": "VPS公网IP/用户选择的TCP端口"
  }
}
```

UDP 打洞失败但仍能访问 Planet 时会显示 `RELAY`，走 ZeroTier UDP 转发；只有 UDP 完全
不可用且客户端启用了 fallback 时才会进入 `TUNNELED`。

## 八、只拿 Compose 时的功能边界

ZTNet 的网络、成员、授权、IPv4/IPv6 地址池、路由、DNS、Multicast、Flow Rules、Tags、
Capabilities、组织、用户、API Token 和 Webhook 管理均可正常使用。

Compose 平台不能允许容器在没有 Docker Socket 或宿主机高权限的情况下，从网页动态修改
Docker 的宿主机端口映射。为了不把 Docker Socket 暴露给 Web 容器，本独立 Compose 模式
中的以下部署层设置必须在 1Panel 环境变量中修改并重建，而不是在网页中热应用：

- 管理端宿主机绑定 IP 和端口；
- ZeroTier 对外 UDP 绑定；
- relay 的启停、宿主机 TCP 端口和来源 CIDR。

这是 Docker 的权限边界，不是文档遗漏。需要网页原子修改宿主机监听、证书文件、iptables
和容器生命周期时，必须使用带受限宿主机配置代理的高级安装模式；该模式不属于“只给一份
Compose 文本”的交付范围。两种模式不能在文档中混写。

## 九、旧生产机原机迁移

迁移前不要删除旧容器，不要运行旧项目的安装脚本。先确定旧 Controller 数据实际位置：

```bash
docker inspect myztplanet \
  --format '{{range .Mounts}}{{println .Destination " <- " .Source}}{{end}}'
docker inspect myztplanet \
  --format 'image={{.Config.Image}} running={{.State.Running}}'
```

找到映射到 `/var/lib/zerotier-one` 的宿主机目录。下文用 `/实际旧数据目录` 表示该路径，
必须替换为检查得到的真实值。

进入维护窗口并备份：

```bash
backup_dir=/var/backups/ztplanet-before-compose
sudo install -d -m 0700 "$backup_dir"
sudo docker stop --time 30 myztplanet
sudo tar --numeric-owner -C /实际旧数据目录 -czf "$backup_dir/zerotier-one.tar.gz" .
cd "$backup_dir"
sudo sha256sum zerotier-one.tar.gz | sudo tee SHA256SUMS
sudo sha256sum -c SHA256SUMS
```

在 1Panel 创建 `ztplanet` 编排，但先不要启动。创建目标命名卷并导入：

```bash
docker volume create ztplanet_zerotier-data

sudo docker run --rm \
  -v ztplanet_zerotier-data:/target \
  -v /var/backups/ztplanet-before-compose:/backup:ro \
  alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
  sh -eu -c 'test -z "$(find /target -mindepth 1 -print -quit)"; tar -C /target -xzf /backup/zerotier-one.tar.gz'
```

然后由 1Panel 启动编排。旧 ztNCUI 的登录用户不会迁移；首次访问 ZTNet 后注册新管理员，
再到 **Admin → Controller → Unlinked networks** 认领旧网络。Controller 的网络 ID、成员、
路由、地址池和 Flow Rules 随 ZeroTier Controller 数据迁移。

如果新版启动失败：

1. 在 1Panel 停止 `ztplanet` 编排；
2. 不要删除新命名卷；
3. 执行 `docker start myztplanet` 恢复旧服务；
4. 根据新版容器日志排错。

新旧 Controller 绝不能同时运行同一份私有身份。

## 十、迁移到另一台 VPS

在旧机按上一节停机并生成带 SHA256 校验的备份，通过 SCP/SFTP 将整个备份目录传到新机。
新机先执行：

```bash
cd /var/backups/ztplanet-before-compose
sudo sha256sum -c SHA256SUMS
```

然后粘贴 Compose、填写两个新安装秘密值、创建 `ztplanet_zerotier-data` 并按上一节导入。
只有新旧 VPS 公网 IP、UDP 端口和 Controller 身份完全保持时，旧 Planet 才可能继续无感
使用；公网地址变化时必须重新生成并分发 Planet/Moon。

## 十一、备份、升级和验收

至少备份三个命名卷：

- `ztplanet_zerotier-data`：Controller 身份、网络和成员；
- `ztplanet_postgres-data`：ZTNet 用户、组织及应用数据；
- `ztplanet_ztnet-planet`：生成和保留的 Planet 文件。

升级时复制新版本提供的完整 Compose 内容，先核对发布安全门禁和镜像摘要，再在 1Panel
执行“拉取并重建”。不要使用 `latest`，不要只升级五个组件中的一部分。

验收至少包括：

```bash
docker ps --filter label=com.docker.compose.project=ztplanet
docker volume ls --filter name=ztplanet_
ss -lntup
```

还要核对旧网络 ID、路由、地址池、规则、成员和授权状态，并用客户端验证 `DIRECT`、UDP
`RELAY`、TCP `TUNNELED` 及关闭 fallback 时的预期失败。旧容器和旧数据至少保留到新版
完成一个正常备份周期。
