# 可直接交付给部署者的 1Panel 部署与迁移文档

本文档本身就是完整交付物。部署者只需要得到本文档，不需要访问 GitHub 项目、不需要下载
任何源代码或附加配置文件，也不需要联系发布者索取 Compose。第三节已经内嵌需要粘贴到
1Panel 的完整 Compose 内容。

适用于 Linux AMD64、ARM64 VPS 和 1Panel 的“容器 → 编排”。只要文档中固定的 Docker Hub
镜像保持公开可拉取，即使源码仓库是私有的，部署者也能独立完成全新部署、访问、备份、
升级、原机迁移和跨机迁移。

## 一、本文档提供的部署内容

第三节的 Compose 已经包含：

- 五个经过双架构安全门禁的 Docker Hub 镜像及不可变清单摘要；
- PostgreSQL、ZeroTier Controller/Planet、ZTNet 和自签名 HTTPS 管理入口；
- 命名卷、内部网络、健康检查、只读文件系统、能力限制和资源限制；
- 默认关闭的 TCP fallback relay；
- 内嵌 Caddy 配置，不依赖宿主机文件。

部署者只需要自行生成两个秘密值。秘密值不能由发布者预先写进公共 Compose，否则所有
安装实例将共享相同数据库密码和登录加密密钥。

Docker Hub 镜像只包含程序代码、固定版本的组件、数据库迁移和安全默认值。以下内容不会
进入镜像：GitHub/Docker Hub 登录凭据、VPS 地址、1Panel 环境变量、数据库密码、管理密码、
ZeroTier 身份和 Controller 数据、网络与成员、Planet/Moon、用户证书私钥、relay 来源 CIDR。
这些实例数据只保存在部署者自己的 1Panel 环境变量和 Docker 命名卷中。

GitHub Actions 中的 `DOCKERHUB_USERNAME` 和 `DOCKERHUB_TOKEN` 只用于向仓库推送镜像，
Dockerfile 没有接收或保存它们。公开镜像允许匿名拉取，不等于公开源码仓库，也不会让
部署者取得发布凭据。

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

## 三、完整 Compose 内容

复制本节稍后给出的整个 `yaml` 代码块，从第一行 `name: ztplanet` 复制到最后一行
`subnet: 172.31.254.0/28`。不要只复制其中一个服务，也不要删除镜像摘要、安全限制、
健康检查、命名卷或网络配置。

<!-- ZTPLANET-COMPOSE-BEGIN -->

```yaml
name: ztplanet

# 本文件用于 1Panel“粘贴 Compose 内容”部署：不需要下载源码或创建宿主机配置文件。
# 创建编排前必须在 1Panel 环境变量中设置：
#   ZTPLANET_DB_PASSWORD：只使用 64 位十六进制随机字符串
#   ZTPLANET_AUTH_SECRET：至少 64 位随机字符串
# 生成方法：分别执行 openssl rand -hex 32 和 openssl rand -hex 48。
# 1Panel 操作：容器 -> 编排 -> 创建编排，名称必须为 ztplanet，粘贴全文并填写上述变量。
# 默认访问：在自己的电脑执行 ssh -N -L 3443:127.0.0.1:3443 用户@VPS公网IP，
# 然后打开 https://localhost:3443。默认公网只需放行 UDP/9993，不要放行 TCP/3443。
# 开放 relay：增加 COMPOSE_PROFILES=relay、RELAY_BIND_ADDRESS、RELAY_PUBLIC_PORT 和
# RELAY_ALLOWED_CIDRS；外层不是真 TLS，留空 CIDR 表示允许任何来源。

services:
  postgres:
    image: docker.io/dlaq/zerotier-planet-test:postgres-v1.1.0@sha256:6ea416f2fb99986e165f4930abdd28fe0c736def0c84e229513fcac8b6e1f401
    restart: unless-stopped
    environment:
      POSTGRES_USER: ztnet
      POSTGRES_DB: ztnet
      POSTGRES_PASSWORD: ${ZTPLANET_DB_PASSWORD:?请设置64位十六进制数据库密码}
      POSTGRES_INITDB_ARGS: --auth-host=scram-sha-256
    command:
      - postgres
      - -c
      - shared_buffers=128MB
      - -c
      - max_connections=50
      - -c
      - work_mem=4MB
      - -c
      - maintenance_work_mem=64MB
      - -c
      - password_encryption=scram-sha-256
    volumes:
      - postgres-data:/var/lib/postgresql/data
    networks:
      app-network:
        ipv4_address: 172.31.255.4
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ztnet -d ztnet"]
      interval: 5s
      timeout: 3s
      retries: 20
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
      - SETGID
      - SETUID
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=64m
    pids_limit: 128
    mem_limit: 512m
    cpus: 1.0

  zerotier:
    image: docker.io/dlaq/zerotier-planet-test:zerotier-v1.1.0@sha256:51be0704376cf67b77f88ecf4544eae9793eeeae9d15947bf167b29154eb086c
    restart: unless-stopped
    volumes:
      - zerotier-data:/var/lib/zerotier-one
    networks:
      app-network:
        ipv4_address: 172.31.255.2
    ports:
      - "${ZT_BIND_ADDRESS:-0.0.0.0}:${ZT_PUBLIC_PORT:-9993}:9993/udp"
    cap_drop:
      - ALL
    cap_add:
      - NET_ADMIN
      - NET_RAW
      - CHOWN
      - DAC_OVERRIDE
      - FOWNER
      - SETGID
      - SETUID
    devices:
      - /dev/net/tun:/dev/net/tun
    security_opt:
      - no-new-privileges:true
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=32m
    pids_limit: 256
    mem_limit: 512m
    cpus: 1.0
    healthcheck:
      test: ["CMD", "zerotier-cli", "-D/var/lib/zerotier-one", "info"]
      interval: 10s
      timeout: 5s
      retries: 12
      start_period: 20s

  ztnet-init:
    image: docker.io/dlaq/zerotier-planet-test:ztnet-v1.1.0@sha256:2db7564eaa8d9fa4909582f7cc254ae783d42e4fd5b064e907c202182286ce33
    restart: "no"
    user: "0:0"
    entrypoint: ["/bin/sh", "-ec"]
    command: ["chown 0:0 /data && chmod 0750 /data && chown -R 1001:1001 /data"]
    volumes:
      - ztnet-planet:/data
    network_mode: none
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
    pids_limit: 128
    mem_limit: 128m
    cpus: 0.25

  ztnet:
    image: docker.io/dlaq/zerotier-planet-test:ztnet-v1.1.0@sha256:2db7564eaa8d9fa4909582f7cc254ae783d42e4fd5b064e907c202182286ce33
    restart: unless-stopped
    user: "1001:1001"
    environment:
      DATABASE_URL: "postgresql://ztnet:${ZTPLANET_DB_PASSWORD:?请设置64位十六进制数据库密码}@postgres:5432/ztnet?schema=public"
      NEXTAUTH_URL: "https://${MANAGEMENT_HOST:-localhost}:${MANAGEMENT_PORT:-3443}"
      NEXTAUTH_URL_INTERNAL: http://ztnet:3000
      NEXTAUTH_SECRET: ${ZTPLANET_AUTH_SECRET:?请设置至少64位认证密钥}
      ZT_ADDR: http://zerotier:9993
      ZT_SECRET_FILE: /run/zerotier-controller/authtoken.secret
      ZT_IDENTITY_PUBLIC_FILE: /run/zerotier-controller/identity.public
      NEXTAUTH_SESSION_MAX_AGE: "28800"
      ZTPLANET_LOGIN_ATTEMPTS: "5"
      ZTPLANET_LOGIN_LOCKOUT_SECONDS: "900"
      NPM_CONFIG_CACHE: /tmp/npm-cache
    volumes:
      - zerotier-data:/run/zerotier-controller:ro
      - ztnet-planet:/var/lib/zerotier-one
      - ztnet-backups:/app/tmp/backups
    networks:
      app-network:
        ipv4_address: 172.31.255.3
    depends_on:
      postgres:
        condition: service_healthy
      zerotier:
        condition: service_healthy
      ztnet-init:
        condition: service_completed_successfully
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=256m,uid=1001,gid=1001
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 20
      start_period: 30s

  gateway-init:
    image: docker.io/dlaq/zerotier-planet-test:postgres-v1.1.0@sha256:6ea416f2fb99986e165f4930abdd28fe0c736def0c84e229513fcac8b6e1f401
    restart: "no"
    user: "0:0"
    entrypoint: ["/bin/sh", "-ec"]
    command: ["chown 0:0 /data /config && chmod 0700 /data /config && chown -R 1002:1002 /data /config"]
    volumes:
      - gateway-data:/data
      - gateway-config:/config
    network_mode: none
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN

  gateway:
    image: docker.io/dlaq/zerotier-planet-test:gateway-v1.1.0@sha256:449c826588895579f6d00356849ed20422fffe5904139c9621ca22de76159131
    restart: unless-stopped
    user: "1002:1002"
    configs:
      - source: caddyfile
        target: /etc/caddy/Caddyfile
        mode: 0444
    volumes:
      - gateway-data:/data
      - gateway-config:/config
    ports:
      - "${MANAGEMENT_BIND_ADDRESS:-127.0.0.1}:${MANAGEMENT_PORT:-3443}:3443/tcp"
    networks:
      - app-network
    depends_on:
      gateway-init:
        condition: service_completed_successfully
      ztnet:
        condition: service_healthy
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 128
    mem_limit: 256m
    cpus: 0.5

  relay:
    image: docker.io/dlaq/zerotier-planet-test:relay-v1.1.0@sha256:01b1391d565d15dff7486cd8a1631781acd1d354d92e77a188a3f17078a8dc34
    profiles: ["relay"]
    restart: unless-stopped
    environment:
      RELAY_LISTEN: 0.0.0.0:4443
      RELAY_METRICS_LISTEN: ""
      RELAY_ALLOWED_CIDRS: ${RELAY_ALLOWED_CIDRS:-}
      RELAY_MAX_CONNECTIONS: ${RELAY_MAX_CONNECTIONS:-128}
      RELAY_MAX_CONNECTIONS_PER_IP: ${RELAY_MAX_CONNECTIONS_PER_IP:-4}
      RELAY_HANDSHAKE_TIMEOUT_SECONDS: ${RELAY_HANDSHAKE_TIMEOUT_SECONDS:-10}
      RELAY_IDLE_TIMEOUT_SECONDS: ${RELAY_IDLE_TIMEOUT_SECONDS:-300}
      RELAY_PACKETS_PER_SECOND: ${RELAY_PACKETS_PER_SECOND:-200}
      RELAY_BYTES_PER_SECOND: ${RELAY_BYTES_PER_SECOND:-2097152}
      RELAY_GLOBAL_PACKETS_PER_SECOND: ${RELAY_GLOBAL_PACKETS_PER_SECOND:-2000}
      RELAY_GLOBAL_BYTES_PER_SECOND: ${RELAY_GLOBAL_BYTES_PER_SECOND:-20971520}
      RELAY_MAX_DESTINATIONS: ${RELAY_MAX_DESTINATIONS:-64}
      RELAY_MIN_DESTINATION_PORT: ${RELAY_MIN_DESTINATION_PORT:-1025}
    ports:
      - "${RELAY_BIND_ADDRESS:-127.0.0.1}:${RELAY_PUBLIC_PORT:-4443}:4443/tcp"
    networks:
      relay-egress:
        ipv4_address: 172.31.254.2
    read_only: true
    tmpfs:
      - /tmp:rw,noexec,nosuid,nodev,size=8m,uid=65532,gid=65532
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    pids_limit: 256
    mem_limit: 256m
    cpus: 1.0
    healthcheck:
      test: ["CMD", "/usr/local/bin/ztplanet-relay", "--healthcheck"]
      interval: 30s
      timeout: 3s
      retries: 3

configs:
  caddyfile:
    content: |
      {
        admin off
        auto_https disable_redirects
      }

      https://${MANAGEMENT_HOST:-localhost}:3443 {
        tls internal
        header {
          -Server
          X-Content-Type-Options "nosniff"
          X-Frame-Options "DENY"
          Referrer-Policy "no-referrer"
          Permissions-Policy "camera=(), microphone=(), geolocation=()"
          Strict-Transport-Security "max-age=31536000"
        }
        reverse_proxy ztnet:3000
      }

volumes:
  zerotier-data:
  ztnet-planet:
  postgres-data:
  ztnet-backups:
  gateway-data:
  gateway-config:

networks:
  app-network:
    driver: bridge
    ipam:
      config:
        - subnet: 172.31.255.0/24
  relay-egress:
    driver: bridge
    ipam:
      config:
        - subnet: 172.31.254.0/28
```

<!-- ZTPLANET-COMPOSE-END -->

## 四、在 1Panel 粘贴部署

进入 **容器 → 编排 → 创建编排**：

1. 编排名称填写 `ztplanet`，不要使用其他名称；
2. 创建方式选择“编辑”或“粘贴 Compose 内容”；
3. 粘贴本文档第三节的完整 `yaml` 代码块；
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
- `ztnet-init`：正常退出，退出码 0；
- `ztnet`：健康；
- `gateway-init`：正常退出，退出码 0；
- `gateway`：运行中；
- `relay`：默认不会创建或运行。

`gateway-init` 是一次性权限初始化任务，成功后显示“已退出”是正常状态，不是故障。

如果曾使用较早的 Compose，出现 `gateway-init didn't complete successfully: exit 1`，不要
删除任何卷。确认 `gateway-init` 的 `command` 与本文第三节完全一致，然后在 1Panel 保存并
“重建”编排。新命令会先临时取回顶层目录所有权、设置权限，再递归交给 UID 1002，因此既能
修复已经失败过的卷，也能在以后重复执行。

如果 `ztnet` 报 `unhealthy`，先查看实际应用日志：

```bash
docker logs ztplanet-ztnet-1
```

本 Compose 已包含 `ztnet-init`，它会在 `ztnet` 启动前把 `ztplanet_ztnet-planet` 卷准备为
UID 1001。若使用旧 Compose 失败过，保留卷并重新粘贴本文第三节完整内容后重建；不要手动
删除 Planet 卷。

健康检查访问根路径只验证进程是否已提供 HTTP 响应；ZTNet 根路径没有业务页面，返回 404
是合法状态，不代表服务故障。5xx 或无法连接才会被判定为不健康。

## 五、默认访问方法

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

## 六、管理端绑定内网或指定地址

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

## 七、ZeroTier UDP 端口

可在 1Panel 环境变量中设置：

```env
ZT_BIND_ADDRESS=0.0.0.0
ZT_PUBLIC_PORT=9993
```

云安全组需要放行相同的 UDP 端口。修改外部端口或公网 IP 后，需要重新生成并向客户端
分发 Planet/Moon；只改 Docker 端口不会自动更新已经安装在客户端上的 Planet 文件。

## 八、可选 TCP fallback relay

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

## 九、本文档部署模式的功能边界

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

## 十、旧生产机原机迁移

本节针对原项目的单容器 `myztplanet`/ztNCUI 部署。迁移前不要删除旧容器，不要运行旧项目
的安装脚本。旧项目把数据拆在两个目录中；只迁移 `/var/lib/zerotier-one` 会丢失发给客户端
使用的 Planet/Moon。

先在 1Panel 容器列表中确认旧容器名称，也可以执行第一条命令查找。旧项目不同安装方式可能
显示为 `ztplanet`、`myztplanet` 或带编排前后缀的名称，不能直接猜测：

```bash
sudo docker ps -a --format '{{.Names}}  {{.Image}}' | grep -E 'zerotier-planet|myztplanet|ztplanet'
legacy_container=上一步显示的真实旧容器名称
sudo docker inspect "$legacy_container" \
  --format '{{range .Mounts}}{{println .Destination " <- " .Source}}{{end}}'
sudo docker inspect "$legacy_container" \
  --format 'image={{.Config.Image}} running={{.State.Running}}'
```

记录两条真实的宿主机路径：

- `/var/lib/zerotier-one` 左侧对应 Controller 数据，下文记为 `legacy_one`；
- `/app/dist` 左侧对应 Planet/Moon，下文记为 `legacy_dist`。

先替换下面两条路径，再执行只读核验。任何一条失败都不要停机：

```bash
legacy_one=/实际旧路径/data/zerotier/one
legacy_dist=/实际旧路径/data/zerotier/dist
sudo test -s "$legacy_one/identity.secret" && echo Controller身份正常
sudo test -s "$legacy_dist/planet" && echo Planet文件正常
```

进入维护窗口，停止旧容器后制作一致性备份：

```bash
backup_dir=/var/backups/ztplanet-before-compose
sudo install -d -m 0700 "$backup_dir"
sudo docker stop --time 30 "$legacy_container"
sudo tar --numeric-owner -C "$legacy_one" -czf "$backup_dir/zerotier-one.tar.gz" .
sudo tar --numeric-owner -C "$legacy_dist" -czf "$backup_dir/legacy-dist.tar.gz" .
sudo sh -c 'cd "$1" && sha256sum zerotier-one.tar.gz legacy-dist.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS' sh "$backup_dir"
```

不要先创建或启动 1Panel 编排。先创建最终名称的两个卷并导入数据，这样新 ZeroTier 第一次
启动时就会使用原身份。卷标签让 Compose 识别它们属于 `ztplanet` 编排：

```bash
sudo docker volume create \
  --label com.docker.compose.project=ztplanet \
  --label com.docker.compose.volume=zerotier-data \
  ztplanet_zerotier-data

sudo docker volume create \
  --label com.docker.compose.project=ztplanet \
  --label com.docker.compose.volume=ztnet-planet \
  ztplanet_ztnet-planet

sudo docker run --rm \
  -v ztplanet_zerotier-data:/target \
  -v /var/backups/ztplanet-before-compose:/backup:ro \
  alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
  sh -eu -c 'test -z "$(find /target -mindepth 1 -print -quit)"; tar -C /target -xzf /backup/zerotier-one.tar.gz; test -s /target/identity.secret'

sudo docker run --rm \
  -v ztplanet_ztnet-planet:/target \
  -v /var/backups/ztplanet-before-compose:/backup:ro \
  alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
  sh -eu -c 'test -z "$(find /target -mindepth 1 -print -quit)"; mkdir -p /target/legacy-dist /target/zt-mkworld; tar -C /target/legacy-dist -xzf /backup/legacy-dist.tar.gz; test -s /target/legacy-dist/planet; cp /target/legacy-dist/planet /target/planet; cp /target/legacy-dist/planet /target/zt-mkworld/planet.custom; chown -R 1001:1001 /target; chmod -R u=rwX,g=rX,o= /target'
```

现在才按第三、四节在 1Panel 创建并启动 `ztplanet` 编排。旧 ztNCUI 的用户和默认密码不会
迁移；首次访问 ZTNet 后注册新的至少 14 位管理员密码，再到 **Admin → Controller →
Unlinked networks** 认领旧网络。Controller 的网络 ID、成员、路由、地址池和 Flow Rules
随 Controller 数据迁移。原 Planet 同时保存在 `legacy-dist`、`planet` 和
`zt-mkworld/planet.custom`，原 Moon 仍在备份与 `legacy-dist` 中。

如果新版启动失败：

1. 在 1Panel 停止 `ztplanet` 编排；
2. 不要删除新命名卷；
3. 执行 `sudo docker start "$legacy_container"` 恢复旧服务；
4. 根据新版容器日志排错。

新旧 Controller 绝不能同时运行同一份私有身份。

## 十一、迁移到另一台 VPS

如果源机器仍是旧单容器，在旧机按上一节生成备份，再打包传输。备份含 Controller 私钥，
传输包只能由当前用户读取：

```bash
sudo tar -C /var/backups -czf /tmp/ztplanet-migration.tar.gz ztplanet-before-compose
sudo chown "$(id -u):$(id -g)" /tmp/ztplanet-migration.tar.gz
chmod 0600 /tmp/ztplanet-migration.tar.gz
scp /tmp/ztplanet-migration.tar.gz 新机管理用户@新VPS公网IP:/tmp/
```

在新机解包并校验：

```bash
sudo install -d -m 0700 /var/backups
sudo tar -C /var/backups -xzf /tmp/ztplanet-migration.tar.gz
sudo sh -c 'cd /var/backups/ztplanet-before-compose && sha256sum -c SHA256SUMS'
```

然后在新机按上一节创建并恢复两个卷，最后才在 1Panel 粘贴 Compose、填写两个新的随机
秘密值并启动。只有新旧 VPS 公网 IP、UDP 端口和 Controller 身份完全保持时，旧 Planet
才可能继续无感使用；公网地址或 UDP 端口变化时必须在新管理端重新生成并分发 Planet/Moon。

如果源机器已经运行本文档的新 Compose，不要只复制两个卷；按下一节停止整个编排并备份
六个卷，同时从密码管理器复制原 `ZTPLANET_DB_PASSWORD` 和 `ZTPLANET_AUTH_SECRET`。新机
必须使用完全相同的两个值恢复，不能在迁移时重新生成。

## 十二、备份、升级和验收

新 Compose 的完整备份包含六个命名卷：

- `ztplanet_zerotier-data`：Controller 身份、网络和成员；
- `ztplanet_postgres-data`：ZTNet 用户、组织及应用数据；
- `ztplanet_ztnet-planet`：生成和保留的 Planet 文件；
- `ztplanet_ztnet-backups`：ZTNet 导出备份；
- `ztplanet_gateway-data`：内部 CA、证书和私钥；
- `ztplanet_gateway-config`：网关运行配置。

还必须在密码管理器中备份原 `ZTPLANET_DB_PASSWORD` 和 `ZTPLANET_AUTH_SECRET`。镜像和
Compose 不含这两个值。丢失数据库密码后，仅复制 PostgreSQL 卷不能恢复应用连接；随意
更换认证密钥会使现有会话和依赖该密钥的数据失效。

直接复制运行中的 PostgreSQL 卷可能产生不一致备份。先在 1Panel 停止整个 `ztplanet`
编排，确认下面命令没有输出，再备份：

```bash
sudo docker ps --filter label=com.docker.compose.project=ztplanet --format '{{.Names}}'

backup_dir=/var/backups/ztplanet-$(date +%Y%m%d-%H%M%S)
sudo install -d -m 0700 "$backup_dir"
for volume in \
  ztplanet_zerotier-data ztplanet_postgres-data ztplanet_ztnet-planet \
  ztplanet_ztnet-backups ztplanet_gateway-data ztplanet_gateway-config
do
  sudo docker volume inspect "$volume" >/dev/null
  sudo docker run --rm \
    -e VOLUME="$volume" \
    -v "$volume:/source:ro" \
    -v "$backup_dir:/backup" \
    alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
    sh -eu -c 'tar -C /source -czf "/backup/${VOLUME}.tar.gz" .'
done
sudo sh -c 'cd "$1" && sha256sum ./*.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS' sh "$backup_dir"
```

校验成功后可以在 1Panel 重新启动编排。跨机恢复新 Compose 时，把整个备份目录安全传到
目标机，设置 `restore_dir` 为真实目录并执行：

```bash
restore_dir=/var/backups/实际备份目录
sudo sh -c 'cd "$1" && sha256sum -c SHA256SUMS' sh "$restore_dir"

for volume in \
  ztplanet_zerotier-data ztplanet_postgres-data ztplanet_ztnet-planet \
  ztplanet_ztnet-backups ztplanet_gateway-data ztplanet_gateway-config
do
  compose_volume=${volume#ztplanet_}
  sudo docker volume create \
    --label com.docker.compose.project=ztplanet \
    --label com.docker.compose.volume="$compose_volume" \
    "$volume" >/dev/null
  sudo docker run --rm \
    -e VOLUME="$volume" \
    -v "$volume:/target" \
    -v "$restore_dir:/backup:ro" \
    alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
    sh -eu -c 'test -z "$(find /target -mindepth 1 -print -quit)"; tar -C /target -xzf "/backup/${VOLUME}.tar.gz"'
done
```

最后使用原来的两个秘密值创建 1Panel 编排。恢复前必须保证目标卷为空，且不能同时运行
新旧两个 Controller。任一卷已经有内容时，上述命令会主动失败，不会覆盖现有数据。

升级时先完成上述停机备份，再复制新版本交付文档中的整个 Compose 代码块，保持原来的两个
秘密值不变，然后在 1Panel 执行“拉取并重建”。不要使用 `latest`，不要自行删除镜像摘要，
也不要只升级五个组件中的一部分。当前文档固定的是 `v1.1.0`；仅当收到新版完整文档并核对
版本说明后才替换。

验收至少包括：

```bash
docker ps --filter label=com.docker.compose.project=ztplanet
docker volume ls --filter name=ztplanet_
ss -lntup
```

还要核对旧网络 ID、路由、地址池、规则、成员和授权状态，并用客户端验证 `DIRECT`、UDP
`RELAY`、TCP `TUNNELED` 及关闭 fallback 时的预期失败。旧容器和旧数据至少保留到新版
完成一个正常备份周期。
