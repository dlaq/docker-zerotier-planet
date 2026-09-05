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
- `./data/` 宿主机目录 bind 挂载、内部网络、健康检查、只读文件系统、能力限制和资源限制；
- 默认关闭的 TCP fallback relay；
- 内嵌 Caddy 配置，不依赖宿主机文件。

部署者只需要自行生成两个秘密值。秘密值不能由发布者预先写进公共 Compose，否则所有
安装实例将共享相同数据库密码和登录加密密钥。

Docker Hub 镜像只包含程序代码、固定版本的组件、数据库迁移和安全默认值。以下内容不会
进入镜像：GitHub/Docker Hub 登录凭据、VPS 地址、1Panel 环境变量、数据库密码、管理密码、
ZeroTier 身份和 Controller 数据、网络与成员、Planet/Moon、用户证书私钥、relay 来源 CIDR。
这些实例数据只保存在部署者自己的 1Panel 环境变量和编排目录下的 `./data/` 宿主机目录中。

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

### 可选：使用 `.env` 文件

使用命令行 Compose 或 1Panel 的“路径选择”模式时，可以把交付包中的
`docker-compose.1panel.env.example` 复制为 Compose 同目录的 `.env`，并替换随机值：

```bash
cp docker-compose.1panel.env.example .env
chmod 600 .env
```

标准 Docker Compose 会自动读取同目录 `.env`。1Panel 的“粘贴 Compose 内容”模式是否读取
该文件取决于 1Panel 版本；如果它不读取，就在环境变量区域填入 `.env` 中的相同键值。
两处同时存在同名变量时，以 1Panel 实际传给 Compose 的值为准；不要让两处值不一致。
动态公网 IP 可以把 `MANAGEMENT_HOST` 留空，或明确设置为 `0.0.0.0`。新版 `gateway-init`
会为这两种值生成一个接受全部 Host 的入口，并用 `localhost` 内部自签名证书作为 TLS 回退；
访问 `https://VPS当前公网IP:3443` 时浏览器会提示自签名/名称不匹配，确认后即可使用。
`0.0.0.0` 不是浏览器中的访问地址，只是“所有 Host/所有本机地址”的配置值。需要无提示访问
时仍建议使用稳定的动态 DNS 名称作为 `MANAGEMENT_HOST`。`MANAGEMENT_BIND_ADDRESS=0.0.0.0`
表示监听全部宿主机地址，会扩大公网暴露面，必须配合云防火墙限制来源。

## 三、完整 Compose 内容

复制本节稍后给出的整个 `yaml` 代码块，从第一行 `name: ztplanet` 复制到最后一行
`subnet: 172.31.254.0/28`。不要只复制其中一个服务，也不要删除镜像摘要、安全限制、
健康检查、bind 挂载或网络配置。Docker 会在编排目录下自动创建 `./data/` 子目录。
不要为了排错执行 `chmod 777`；`ztnet-init` 会在 ZeroTier 健康后把控制器目录设为
`root:1001`、把 ZTNet 必需的 `authtoken.secret`、`identity.public` 和 `planet` 设为
`root:1001/0640`。`gateway-init` 会生成 `./data/gateway-config/caddy/Caddyfile`，并把
网关运行目录设为 UID/GID 1002；gateway 以只读 bind 挂载读取 Caddyfile。这样兼容不支持
`configs.content` 的 1Panel 版本，也不会让运行中的网关写入 Caddyfile。两个初始化容器为
了修复旧版本留下的 0700 私有子目录，会临时使用 `CHOWN` 和 `DAC_OVERRIDE` capability；
它们没有网络、没有 Docker Socket，完成后立即退出。

<!-- ZTPLANET-COMPOSE-BEGIN -->

```yaml
name: ztplanet

# 本文件用于 1Panel“粘贴 Compose 内容”部署：不需要下载源码或创建宿主机配置文件。
# 创建编排前必须在 1Panel 环境变量中设置：
#   ZTPLANET_DB_PASSWORD：只使用 64 位十六进制随机字符串
#   ZTPLANET_AUTH_SECRET：至少 64 位随机字符串
# 生成方法：分别执行 openssl rand -hex 32 和 openssl rand -hex 48。
# 1Panel 操作：容器 -> 编排 -> 创建编排，名称必须为 ztplanet，粘贴全文并填写上述变量。
# 使用标准 docker compose 时，可将 docker-compose.1panel.env.example 复制为同目录的 .env；
# Compose 会自动读取 .env。1Panel 粘贴模式若不读取 .env，则在环境变量区填写相同键值。
# 所有持久化数据均写入编排目录下的 ./data/ 子目录，不使用 Docker named volume。
# 默认访问：在自己的电脑执行 ssh -N -L 3443:127.0.0.1:3443 用户@VPS公网IP，
# 然后打开 https://localhost:3443。默认公网只需放行 UDP/9993，不要放行 TCP/3443。
# 1Panel 部分版本不支持 Compose configs.content；gateway-init 会把 Caddyfile 写入
# ./data/gateway-config/caddy，并由 gateway 以只读 bind 挂载加载。
# 开放 relay：增加 COMPOSE_PROFILES=relay、RELAY_BIND_ADDRESS、RELAY_PUBLIC_PORT 和
# RELAY_ALLOWED_CIDRS；外层不是真 TLS，留空 CIDR 表示允许任何来源。
# MANAGEMENT_HOST 可以留空或设置为 0.0.0.0。两种值都会生成“全部 Host”入口，
# 并用 localhost 的内部自签名证书作为 TLS 回退；浏览器访问动态公网 IP 时会出现
# 自签名/名称不匹配提示，确认后即可使用。设置为域名或固定 IP 时只匹配该名称。

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
      - ./data/postgres:/var/lib/postgresql/data
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
      - ./data/zerotier:/var/lib/zerotier-one
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
    command:
      - |
        chown 0:0 /data /backups
        chmod 0750 /data /backups
        chown -R 1001:1001 /data /backups
        chown 0:1001 /controller
        chmod 2750 /controller
        if [ -e /controller/authtoken.secret ]; then
          chown 0:1001 /controller/authtoken.secret
          chmod 0640 /controller/authtoken.secret
        fi
        if [ -e /controller/identity.public ]; then
          chown 0:1001 /controller/identity.public
          chmod 0640 /controller/identity.public
        fi
        if [ -e /controller/planet ]; then
          chown 0:1001 /controller/planet
          chmod 0640 /controller/planet
        fi
    depends_on:
      zerotier:
        condition: service_healthy
    volumes:
      - ./data/ztnet-planet:/data
      - ./data/ztnet-backups:/backups
      - ./data/zerotier:/controller
    network_mode: none
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      # 递归修复可能由旧版 UID 创建的私有目录；初始化容器无网络且不挂载
      # Docker Socket，运行完成后立即退出。
      - DAC_OVERRIDE
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
      # Next.js 默认读取 Docker 注入的 HOSTNAME（容器 ID），会导致只监听容器地址；
      # 显式监听所有容器接口，供本地健康检查和 gateway 访问。
      HOSTNAME: 0.0.0.0
      NEXTAUTH_SESSION_MAX_AGE: "28800"
      ZTPLANET_PASSWORD_MIN_LENGTH: "${ZTPLANET_PASSWORD_MIN_LENGTH:-14}"
      ZTPLANET_PASSWORD_MIN_CLASSES: "${ZTPLANET_PASSWORD_MIN_CLASSES:-2}"
      ZTPLANET_TRUST_PROXY: "${ZTPLANET_TRUST_PROXY:-true}"
      ZTPLANET_REGISTER_RATE_LIMIT_WINDOW: "${ZTPLANET_REGISTER_RATE_LIMIT_WINDOW:-10}"
      ZTPLANET_REGISTER_RATE_LIMIT_MAX: "${ZTPLANET_REGISTER_RATE_LIMIT_MAX:-60}"
      RATE_LIMIT_WINDOW: "${RATE_LIMIT_WINDOW:-10}"
      RATE_LIMIT_MAX_REQUESTS: "${RATE_LIMIT_MAX_REQUESTS:-60}"
      RATE_LIMIT_MAX_REQUESTS_SHORT: "${RATE_LIMIT_MAX_REQUESTS_SHORT:-10}"
      ZTPLANET_LOGIN_ATTEMPTS: "${ZTPLANET_LOGIN_ATTEMPTS:-5}"
      ZTPLANET_LOGIN_LOCKOUT_SECONDS: "${ZTPLANET_LOGIN_LOCKOUT_SECONDS:-900}"
      NPM_CONFIG_CACHE: /tmp/npm-cache
    volumes:
      - ./data/zerotier:/run/zerotier-controller:ro
      - ./data/ztnet-planet:/var/lib/zerotier-one
      - ./data/ztnet-backups:/app/tmp/backups
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
      # 使用镜像内的静态资源探测 HTTP 进程，避免根路径重定向或页面逻辑误报。
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:3000/favicon.ico').then(r=>process.exit(r.status<500?0:1)).catch(()=>process.exit(1))"]
      interval: 15s
      timeout: 5s
      retries: 20
      # ARM 首次启动可能要先完成 Prisma migration/seed，给应用足够预热时间。
      start_period: 90s

  gateway-init:
    image: docker.io/dlaq/zerotier-planet-test:postgres-v1.1.0@sha256:6ea416f2fb99986e165f4930abdd28fe0c736def0c84e229513fcac8b6e1f401
    restart: "no"
    user: "0:0"
    entrypoint: ["/bin/sh", "-ec"]
    environment:
      # 保留空字符串；由 gateway-init 在容器内判断空值和 0.0.0.0，避免 Compose
      # 的默认值把动态公网 IP 错误地固定成 localhost。
      MANAGEMENT_HOST: "${MANAGEMENT_HOST-}"
    command:
      - |
        umask 027
        chown 0:0 /data /config /caddy
        chmod 0700 /data /config
        chmod 0750 /caddy
        if [ -L /caddy/Caddyfile ]; then rm -f /caddy/Caddyfile; fi
        management_host="$${MANAGEMENT_HOST:-}"
        case "$${management_host}" in
          ""|0.0.0.0)
            # 空主机名的 HTTPS 监听没有证书主题。先为 localhost 生成内部证书，作为
            # SNI 回退；第二个站点块接受当前动态公网 IP 或其他 Host。
            cat > /caddy/Caddyfile <<'EOF'
        {
          admin off
          auto_https disable_redirects
          default_sni localhost
          fallback_sni localhost
        }

        (management) {
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

        https://localhost:3443 {
          import management
        }

        https://:3443 {
          import management
        }
        EOF
            ;;
          *[!A-Za-z0-9._:-]*)
            echo "MANAGEMENT_HOST 只能包含字母、数字、点、短横线、下划线、冒号" >&2
            exit 1
            ;;
          *)
            cat > /caddy/Caddyfile <<EOF
        {
          admin off
          auto_https disable_redirects
        }

        (management) {
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

        https://$${management_host}:3443 {
          import management
        }
        EOF
            ;;
        esac
        chown -R 1002:1002 /data /config
        chown 0:1002 /caddy /caddy/Caddyfile
        chmod 0640 /caddy/Caddyfile
    volumes:
      - ./data/gateway-data:/data
      - ./data/gateway-config/runtime:/config
      - ./data/gateway-config/caddy:/caddy
    network_mode: none
    read_only: true
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      # 递归修复 Caddy 之前创建的 0700 子目录需要先穿过其权限；该
      # capability 只存在于 network_mode:none 的一次性初始化容器中。
      - DAC_OVERRIDE
      - CHOWN

  gateway:
    image: docker.io/dlaq/zerotier-planet-test:gateway-v1.1.0@sha256:449c826588895579f6d00356849ed20422fffe5904139c9621ca22de76159131
    restart: unless-stopped
    user: "1002:1002"
    environment:
      # Caddy 在 scratch 镜像中没有 passwd/HOME；显式指定 XDG 路径，避免
      # tls internal 尝试在只读根目录创建 /.local。
      HOME: /config
      XDG_CONFIG_HOME: /config
      XDG_DATA_HOME: /data
    volumes:
      - ./data/gateway-data:/data
      - ./data/gateway-config/runtime:/config
      - ./data/gateway-config/caddy:/etc/caddy:ro
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

如果 1Panel 报 `cannot create config ... configs.content`，说明它的 Compose 实现不支持
内联 Config 对象；请使用本文最新的完整 Compose。新版不再声明顶层 `configs:`，而是由
`gateway-init` 在 `./data/gateway-config/caddy/Caddyfile` 生成配置，`gateway` 以只读 bind
挂载读取它。无需重建或重新拉取镜像，也不要删除 `./data/`；在 1Panel 保存后选择“重建”
编排即可。

如果 `gateway` 日志出现 `mkdir /.local: read-only file system`，说明仍在使用旧 Compose。
新版为 Caddy 显式设置 `HOME=/config`、`XDG_CONFIG_HOME=/config` 和 `XDG_DATA_HOME=/data`，
`tls internal` 生成的 CA 会保存到 `./data/gateway-data`，不会再写只读根目录。

如果曾使用较早的 Compose，出现 `gateway-init didn't complete successfully: exit 1`，不要
删除任何 `./data/` 目录。确认 `gateway-init` 的 `command` 与本文第三节完全一致，然后在
1Panel 保存并“重建”编排。新命令会先临时取回顶层目录所有权、设置权限，再递归交给 UID
1002，因此既能修复已经失败过的目录，也能在以后重复执行。

如果 `ztnet` 报 `unhealthy`，先确认 1Panel 是否真的重建了 `ztnet` 容器。仅点击“启动”可能
会继续使用旧容器中的旧健康检查；请先停止编排，再使用“重建”。这只会重建容器和网络，
不会删除 `./data/`。命令行等价操作如下（不要加 `-v`）：

```bash
cd "1Panel 显示的实际编排目录"
sudo docker compose -p ztplanet down --remove-orphans
sudo docker compose -p ztplanet up -d --force-recreate
```

重建后再查看实际应用日志：

```bash
docker logs ztplanet-ztnet-1
```

确认容器实际采用了新的健康检查（输出中应包含 `favicon.ico` 和 `status<500`）：

```bash
sudo docker inspect ztplanet-ztnet-1 \
  --format '{{json .Config.Healthcheck.Test}}'
```

本 Compose 已包含 `ztnet-init`，它会等待 ZeroTier 健康后，在 `ztnet` 启动前把
`./data/ztnet-planet` 和 `./data/ztnet-backups` 准备为 UID 1001，并修正控制器密钥的
共享读取权限。若使用旧 Compose 失败过，保留 `./data/` 目录并重新粘贴本文第三节完整
内容后重建；不要手动删除 Planet 数据。

重建后可验证 ZTNet 是否能读取控制器密钥：

```bash
sudo docker exec ztplanet-ztnet-1 /bin/sh -c \
  'id; ls -ld /run/zerotier-controller; ls -l \
  /run/zerotier-controller/authtoken.secret \
  /run/zerotier-controller/identity.public \
  /run/zerotier-controller/planet'
```

目录应为 `root 1001` 且至少可由组读取（例如 `drwxr-x---`、`-rw-r-----`）。
`identity.secret` 不在 ZTNet 的必需文件列表中，不应改为组可读。

健康检查访问镜像内的静态 `favicon.ico`，只验证进程是否已提供 HTTP 响应，不执行登录页或
业务页面逻辑。5xx 或无法连接才会被判定为不健康。若重建后仍为 `unhealthy`，
请同时提供健康检查输出和 `docker logs`，不要删除 `./data/`。

如果这台机器曾使用本项目早期版本的 Docker named volume，不能直接切换 Compose 后期待
数据自动出现；先完成一次“旧卷 → `./data/`”迁移。下面的命令只把旧卷作为只读来源，新的
Compose 始终只使用 bind 挂载，旧卷在验收前保留不删除：

```bash
compose_dir="/1Panel界面显示的实际编排目录"
data_root="$compose_dir/data"
sudo install -d -m 0750 -o root -g root "$data_root"
for directory in postgres zerotier ztnet-planet ztnet-backups gateway-data gateway-config; do
  sudo install -d -m 0750 -o root -g root "$data_root/$directory"
done
# 先在 1Panel 停止旧编排，确认旧容器均已停止。
copy_old_volume() {
  old_volume=$1
  target=$2
  if ! sudo docker volume inspect "$old_volume" >/dev/null 2>&1; then
    return 0
  fi
  sudo sh -c 'test -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)"' sh "$target"
  sudo docker run --rm --network none --cap-drop ALL \
    --security-opt no-new-privileges:true \
    --mount "type=volume,src=$old_volume,dst=/source,readonly" \
    --mount "type=bind,src=$target,dst=/target" \
    alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
    sh -eu -c 'tar -C /source -cf - . | tar -C /target -xf -'
}
copy_old_volume ztplanet_postgres-data "$data_root/postgres"
copy_old_volume ztplanet_zerotier-data "$data_root/zerotier"
copy_old_volume ztplanet_ztnet-planet "$data_root/ztnet-planet"
copy_old_volume ztplanet_ztnet-backups "$data_root/ztnet-backups"
copy_old_volume ztplanet_gateway-data "$data_root/gateway-data"
copy_old_volume ztplanet_gateway-config "$data_root/gateway-config"
sudo chown -R 0:1001 "$data_root/zerotier"
sudo chmod 2770 "$data_root/zerotier"
sudo chown -R 1001:1001 "$data_root/ztnet-planet" "$data_root/ztnet-backups"
sudo chmod 0750 "$data_root/ztnet-planet" "$data_root/ztnet-backups"
sudo chown -R 1002:1002 "$data_root/gateway-data" "$data_root/gateway-config"
sudo chmod 0700 "$data_root/gateway-data" "$data_root/gateway-config"
```

确认 `identity.secret`、Planet 文件和目录大小无误后，再粘贴本文第三节的新版 Compose。
旧卷不要执行 `docker volume rm`；确认新实例完成备份和客户端验收后再按运维策略处理。

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
预期现象。第一个注册账户成为管理员，随后公开注册自动关闭。

默认密码规则为 14-128 位，且必须包含小写字母、大写字母、数字中的至少两类。个人使用
可以在 `.env` 或 1Panel 环境变量中调整（修改后重启 `ztnet`）：

```env
ZTPLANET_PASSWORD_MIN_LENGTH=8
ZTPLANET_PASSWORD_MIN_CLASSES=1
```

长度会被限制在 8-128，字符类别数会被限制在 1-3；低于安全下限的值不会关闭校验。
注册限流默认按客户端 IP 每 10 分钟 60 次，不同 IP 不再共享同一注册桶。可按需调整：

```env
ZTPLANET_REGISTER_RATE_LIMIT_WINDOW=10
ZTPLANET_REGISTER_RATE_LIMIT_MAX=60
```

修改限流或密码规则后，在 1Panel 对 `ztplanet` 执行“重建/重新创建”即可；不需要删除
`./data`，也不需要重新构建数据库、ZeroTier 或网关镜像。若刚刚触发旧版内存限流，重启
`ztnet` 会清空该进程的临时计数；如果提示的是“Too many failed attempts”，那是已有
账户的登录锁定，可调整 `ZTPLANET_LOGIN_ATTEMPTS` 与 `ZTPLANET_LOGIN_LOCKOUT_SECONDS`。

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
| `MANAGEMENT_HOST` | `localhost` | HTTPS 证书名称和 ZTNet 标准访问地址；可留空或设为 `0.0.0.0` 以接受动态公网 Host |
| `MANAGEMENT_PORT` | `3443` | 宿主机公开的管理端 TCP 端口 |

例如只允许通过 VPS 的内网地址 `192.168.10.20` 访问：

```env
MANAGEMENT_BIND_ADDRESS=192.168.10.20
MANAGEMENT_HOST=192.168.10.20
MANAGEMENT_PORT=3443
```

`MANAGEMENT_BIND_ADDRESS=0.0.0.0` 会包含公网、内网及可能存在的 ZeroTier 接口。Compose
不会禁止部署者这样做，但必须同时使用云安全组限制来源，并明确承担公网管理面的风险。
如果公网 IP 会变化，可以改用：

```env
MANAGEMENT_BIND_ADDRESS=0.0.0.0
MANAGEMENT_HOST=0.0.0.0
MANAGEMENT_PORT=3443
```

或者把 `MANAGEMENT_HOST` 留空。两种配置都会接受当前公网 IP；Caddy 使用 `localhost` 的
内部自签名证书回退，因此浏览器需要确认证书警告。登录回调和邀请链接若要使用稳定地址，
优先填写动态 DNS 名称，而不是使用 `0.0.0.0`。
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

不要先启动新 Controller。先在 1Panel 编排详情中记下 Compose 项目目录（下文记为
`compose_dir`），在该目录准备 `./data/` bind 目录并导入数据。这样新 ZeroTier 第一次
启动时就会使用原身份：

```bash
compose_dir="/1Panel界面显示的实际编排目录"
data_dir="$compose_dir/data"
sudo install -d -m 0750 -o root -g root "$data_dir"
for directory in postgres zerotier ztnet-planet ztnet-backups gateway-data gateway-config; do
  sudo install -d -m 0750 -o root -g root "$data_dir/$directory"
done

sudo sh -c 'test -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)"' sh "$data_dir/zerotier"
sudo sh -c 'test -z "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit)"' sh "$data_dir/ztnet-planet"
sudo tar --no-same-owner --no-same-permissions -C "$data_dir/zerotier" -xzf \
  "$backup_dir/zerotier-one.tar.gz"
sudo test -s "$data_dir/zerotier/identity.secret"
sudo chown -R 0:1001 "$data_dir/zerotier"
sudo chmod 2770 "$data_dir/zerotier"

sudo mkdir -p "$data_dir/ztnet-planet/legacy-dist" "$data_dir/ztnet-planet/zt-mkworld"
sudo tar --no-same-owner --no-same-permissions -C "$data_dir/ztnet-planet/legacy-dist" -xzf \
  "$backup_dir/legacy-dist.tar.gz"
sudo test -s "$data_dir/ztnet-planet/legacy-dist/planet"
sudo cp "$data_dir/ztnet-planet/legacy-dist/planet" "$data_dir/ztnet-planet/planet"
sudo cp "$data_dir/ztnet-planet/legacy-dist/planet" "$data_dir/ztnet-planet/zt-mkworld/planet.custom"
sudo chown -R 1001:1001 "$data_dir/ztnet-planet"
sudo chmod 0750 "$data_dir/ztnet-planet"
```

现在才按第三、四节在 1Panel 创建并启动 `ztplanet` 编排。旧 ztNCUI 的用户和默认密码不会
迁移；首次访问 ZTNet 后注册新的至少 14 位管理员密码，再到 **Admin → Controller →
Unlinked networks** 认领旧网络。Controller 的网络 ID、成员、路由、地址池和 Flow Rules
随 Controller 数据迁移。原 Planet 同时保存在 `legacy-dist`、`planet` 和
`zt-mkworld/planet.custom`，原 Moon 仍在备份与 `legacy-dist` 中。

如果新版启动失败：

1. 在 1Panel 停止 `ztplanet` 编排；
2. 不要删除 `compose_dir/data`；
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

然后在新机按上一节创建并恢复 `./data/` bind 目录，最后才在 1Panel 粘贴 Compose、填写两个
新的随机秘密值并启动。只有新旧 VPS 公网 IP、UDP 端口和 Controller 身份完全保持时，旧 Planet
才可能继续无感使用；公网地址或 UDP 端口变化时必须在新管理端重新生成并分发 Planet/Moon。

如果源机器已经运行本文档的新 Compose，不要只复制两个目录；按下一节停止整个编排并备份
全部 `./data/` 目录，同时从密码管理器复制原 `ZTPLANET_DB_PASSWORD` 和 `ZTPLANET_AUTH_SECRET`。新机
必须使用完全相同的两个值恢复，不能在迁移时重新生成。

## 十二、备份、升级和验收

新 Compose 的持久化数据全部位于编排目录下的 bind 目录：

- `./data/zerotier`：Controller 身份、网络和成员；
- `./data/postgres`：PostgreSQL 原始目录；
- `./data/ztnet-planet`：生成和保留的 Planet 文件；
- `./data/ztnet-backups`：ZTNet 导出备份；
- `./data/gateway-data`：内部 CA、证书和私钥；
- `./data/gateway-config/runtime`：网关运行配置和 Caddy 自动保存状态；
  `./data/gateway-config/caddy/Caddyfile`：由 `gateway-init` 生成、由 gateway 只读加载的入口配置。

还必须在密码管理器中备份原 `ZTPLANET_DB_PASSWORD` 和 `ZTPLANET_AUTH_SECRET`。镜像和
Compose 不含这两个值。PostgreSQL 日常恢复以 `pg_dump` 为准；原始目录归档仅用于同版本
灾难恢复，不能替代逻辑备份。

先在编排运行期间导出数据库，再停止整个编排归档 bind 目录。下面的命令会从容器挂载信息
自动找到真实的 `./data` 宿主机目录，不需要猜 1Panel 路径：

```bash
set -eu
backup_dir=/var/backups/ztplanet-$(date +%Y%m%d-%H%M%S)
sudo install -d -m 0700 "$backup_dir"
postgres_container=$(sudo docker ps \
  --filter label=com.docker.compose.project=ztplanet \
  --filter label=com.docker.compose.service=postgres --format '{{.Names}}')
test -n "$postgres_container"
postgres_source=$(sudo docker inspect "$postgres_container" \
  --format '{{range .Mounts}}{{if eq .Destination "/var/lib/postgresql/data"}}{{.Source}}{{end}}{{end}}')
test -n "$postgres_source"
data_root=$(dirname "$postgres_source")
tmp_dump=$(mktemp /tmp/ztplanet-pgdump.XXXXXX)
trap 'rm -f "$tmp_dump"' EXIT
sudo docker exec "$postgres_container" sh -eu -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump --format=custom --no-owner --username="$POSTGRES_USER" "$POSTGRES_DB"' \
  > "$tmp_dump"
sudo install -m 0600 "$tmp_dump" "$backup_dir/ztnet.pgdump"

# 在 1Panel 点击“停止”，确认下面命令没有输出后继续。
test -z "$(sudo docker ps --filter label=com.docker.compose.project=ztplanet --format '{{.Names}}')"
sudo tar --numeric-owner -C "$data_root/postgres" -czf "$backup_dir/postgres-data.tar.gz" .
sudo tar --numeric-owner -C "$data_root/zerotier" -czf "$backup_dir/zerotier-state.tar.gz" .
sudo tar --numeric-owner -C "$data_root/ztnet-planet" -czf "$backup_dir/ztnet-planet.tar.gz" .
sudo tar --numeric-owner -C "$data_root/ztnet-backups" -czf "$backup_dir/ztnet-backups.tar.gz" .
sudo tar --numeric-owner -C "$data_root/gateway-data" -czf "$backup_dir/gateway-data.tar.gz" .
sudo tar --numeric-owner -C "$data_root/gateway-config" -czf "$backup_dir/gateway-config.tar.gz" .
sudo sh -c 'cd "$1" && sha256sum ./*.tar.gz > SHA256SUMS && sha256sum -c SHA256SUMS' sh "$backup_dir"
```

迁移到另一台 VPS 时，把备份目录和原来的两个秘密值安全传输。目标机先在 1Panel 创建
编排并停止一次，记下其 `./data` 实际目录 `data_root`，再校验和恢复目录内容：

```bash
restore_dir=/var/backups/实际备份目录
data_root="/1Panel实际编排目录/data"
sudo sh -c 'cd "$1" && sha256sum -c SHA256SUMS' sh "$restore_dir"
for directory in postgres zerotier ztnet-planet ztnet-backups gateway-data gateway-config; do
  sudo install -d -m 0750 -o root -g root "$data_root/$directory"
done
sudo find "$data_root/postgres" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo tar --no-same-owner --no-same-permissions -C "$data_root/postgres" -xzf "$restore_dir/postgres-data.tar.gz"
sudo find "$data_root/zerotier" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo tar --no-same-owner --no-same-permissions -C "$data_root/zerotier" -xzf "$restore_dir/zerotier-state.tar.gz"
sudo find "$data_root/ztnet-planet" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo tar --no-same-owner --no-same-permissions -C "$data_root/ztnet-planet" -xzf "$restore_dir/ztnet-planet.tar.gz"
sudo find "$data_root/ztnet-backups" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo tar --no-same-owner --no-same-permissions -C "$data_root/ztnet-backups" -xzf "$restore_dir/ztnet-backups.tar.gz"
sudo find "$data_root/gateway-data" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo tar --no-same-owner --no-same-permissions -C "$data_root/gateway-data" -xzf "$restore_dir/gateway-data.tar.gz"
sudo find "$data_root/gateway-config" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
sudo tar --no-same-owner --no-same-permissions -C "$data_root/gateway-config" -xzf "$restore_dir/gateway-config.tar.gz"
```

然后使用原来的两个秘密值启动编排；启动后先停止 `ztnet` 和 `gateway`，只保留
`postgres` 运行，再恢复逻辑备份，避免应用在恢复期间访问数据库（原始目录归档只在同一
PostgreSQL 大版本的灾难恢复场景使用）：

```bash
postgres_container=$(sudo docker ps \
  --filter label=com.docker.compose.project=ztplanet \
  --filter label=com.docker.compose.service=postgres --format '{{.Names}}')
# 在 1Panel 中停止 ztnet 和 gateway，保持 postgres 运行。
sudo cat "$restore_dir/ztnet.pgdump" | sudo docker exec -i "$postgres_container" sh -eu -c \
  'PGPASSWORD="$POSTGRES_PASSWORD" pg_restore --clean --if-exists --no-owner --username="$POSTGRES_USER" --dbname="$POSTGRES_DB"'
```

恢复命令成功后，在 1Panel 启动全部服务，再检查 `postgres`、`zerotier`、`ztnet` 和网关状态。

恢复前必须保证目标 `./data/` 目录可被替换，且不能同时运行新旧两个 Controller。升级时先
完成上述停机备份，再复制新版本交付文档中的整个 Compose 代码块，保持原来的两个秘密值
不变，然后在 1Panel 执行“拉取并重建”。不要使用 `latest`，不要自行删除镜像摘要，也不要
只升级五个组件中的一部分。当前文档固定的是 `v1.1.0`；仅当收到新版完整文档并核对版本
说明后才替换。

验收至少包括：

```bash
docker ps --filter label=com.docker.compose.project=ztplanet
find /1Panel实际编排目录/data -maxdepth 2 -type d -print
ss -lntup
```

还要核对旧网络 ID、路由、地址池、规则、成员和授权状态，并用客户端验证 `DIRECT`、UDP
`RELAY`、TCP `TUNNELED` 及关闭 fallback 时的预期失败。旧容器和旧数据至少保留到新版
完成一个正常备份周期。
