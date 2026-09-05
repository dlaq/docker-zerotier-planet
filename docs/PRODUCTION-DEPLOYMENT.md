# 1Panel 生产部署与旧版迁移

本文以 1Panel 的“容器 → 编排”作为容器生命周期入口，支持 Linux AMD64 和 ARM64。
Compose 项目固定名为 `ztplanet`，五个镜像使用同一不可变版本标签。宿主机配置助手不
挂载 Docker Socket，只处理经过校验的配置、证书、审计和受限 Compose 操作。

不要再次运行旧项目安装脚本；旧脚本会删除原 `data/zerotier`。旧版
`myztplanet/ztNCUI` 到本版属于迁移，不是普通镜像升级。

## 一、发布模型与架构

正式标签发布以下五个多架构镜像，每个标签必须同时包含 `linux/amd64` 和
`linux/arm64`：

```text
dlaq/zerotier-planet-test:zerotier-v1.1.0
dlaq/zerotier-planet-test:ztnet-v1.1.0
dlaq/zerotier-planet-test:relay-v1.1.0
dlaq/zerotier-planet-test:postgres-v1.1.0
dlaq/zerotier-planet-test:gateway-v1.1.0
```

流水线使用 AMD64、ARM64 原生 GitHub runner 分别构建并扫描镜像，生成两套 SBOM；每个
架构标签对应通过扫描的本地镜像，两种架构全部成功后才合成正式多架构标签。生产机执行
`uname -m`，支持 `x86_64`、`aarch64` 或 `arm64`。

Docker Hub 凭据只能存入 GitHub Actions Secrets：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名；
- `DOCKERHUB_TOKEN`：仅有目标仓库读写权限的 Access Token；
- `DOCKERHUB_REPOSITORY`：普通 Actions Variable，默认 `zerotier-planet-test`。

## 二、全新 ARM64/AMD64 VPS 准备

确认 1Panel 已安装并已启动 Docker：

```bash
uname -m
docker version
docker compose version
test -c /dev/net/tun
```

Docker Compose 必须为 `2.24.4` 或更高版本，以支持安全替换端口列表。克隆与镜像版本
相同的源码标签：

```bash
sudo git clone --branch v1.1.0 --depth 1 \
  https://github.com/dlaq/docker-zerotier-planet.git \
  /srv/ztplanet-v1.1.0

cd /srv/ztplanet-v1.1.0
sudo ./scripts/prepare-1panel.sh v1.1.0 dlaq/zerotier-planet-test
```

准备程序只完成以下工作，不启动业务容器：

- 将当前发行文件安装到 `/opt/ztplanet`；
- 在 `/etc/ztplanet/runtime.env` 生成数据库密码和 NextAuth 密钥；
- 生成自签名证书、默认 Caddy 配置和 Compose override；
- 安装不接触 Docker Socket 的受限配置助手；
- 写入精确的 Docker Hub 镜像引用。

不要把 `/etc/ztplanet/runtime.env`、`agent.secret`、证书私钥或 Controller 数据复制到
1Panel 的 Compose 文本、截图、工单或聊天中。

## 三、在 1Panel 创建编排

进入 **容器 → 编排 → 创建编排**：

1. 名称填写 `ztplanet`；
2. 创建方式选择“路径选择”；
3. Compose 路径选择 `/opt/ztplanet/docker-compose.yml`；
4. 环境变量填写 `ZTPLANET_RELEASE=v1.1.0`；
5. 确认后由 1Panel 拉取并启动。

也可以将 Compose 内容粘贴进 1Panel，但路径选择更便于核对版本。不要删除 Compose 中
的安全限制、固定项目名或绝对只读挂载。

启动后检查：

```bash
docker compose \
  --project-directory /opt/ztplanet \
  --env-file /etc/ztplanet/images.env \
  -f /opt/ztplanet/docker-compose.yml ps
docker ps --filter label=com.docker.compose.project=ztplanet
sudo ss -lntup
```

默认只公开 ZeroTier `UDP/9993`。管理端为 `https://127.0.0.1:3443`，通过 SSH 隧道
访问：

```bash
ssh -N -L 3443:127.0.0.1:3443 管理用户@VPS公网IP
```

浏览器打开 `https://127.0.0.1:3443`，接受预期的自签名证书警告。第一个注册用户成为
管理员，随后注册自动关闭。

云安全组只应默认放行可信来源的 SSH 和 `UDP/9993`。不要把 TCP/3443 对公网开放。
启用 TCP fallback relay 后，只放行管理页面中选定的 TCP 端口。Docker 端口可能绕过
部分 UFW/firewalld 规则，因此还应检查云安全组和 `DOCKER-USER` 链。

## 四、旧生产环境只读盘点

在任何停机或复制之前执行：

```bash
docker inspect myztplanet \
  --format '{{range .Mounts}}{{println .Destination " <- " .Source}}{{end}}'
docker inspect myztplanet \
  --format 'image={{.Config.Image}} running={{.State.Running}}'
docker port myztplanet
docker ps --filter name=myztplanet
```

必须以第一条输出确认 `/var/lib/zerotier-one` 对应的真实宿主机目录。下文用
`/旧仓库准确路径/data/zerotier` 作为占位符，不能未经核对直接照抄。

## 五、旧版维护窗口与离线备份

```bash
legacy_data=/旧仓库准确路径/data/zerotier
legacy_backup=/var/backups/ztplanet-legacy/before-v1.1.0

sudo install -d -m 0700 "$legacy_backup"
sudo docker stop --time 30 myztplanet
sudo tar --numeric-owner -C "$legacy_data" -czf "$legacy_backup/one.tar.gz" one

for item in dist config ztncui; do
  if sudo test -e "$legacy_data/$item"; then
    sudo tar --numeric-owner -C "$legacy_data" \
      -czf "$legacy_backup/$item.tar.gz" "$item"
  fi
done

(cd "$legacy_backup" && sudo sha256sum ./*.tar.gz | sudo tee SHA256SUMS)
(cd "$legacy_backup" && sudo sha256sum -c SHA256SUMS)
```

`one.tar.gz` 包含 Controller 身份、Token、网络和成员配置；`dist.tar.gz` 包含客户端
当前使用的 Planet/Moon。它们都属于密钥数据，必须再保存一份离线副本。

## 六、在旧 VPS 原机迁移到 1Panel Compose

旧容器保持停止。完成第二、三节的发行准备，但暂时不要在 1Panel 启动编排，然后导入
Controller 状态：

```bash
sudo docker volume create ztplanet_zerotier-data
sudo docker run --rm \
  -v ztplanet_zerotier-data:/target \
  -v "$legacy_backup:/backup:ro" \
  alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
  sh -eu -c 'test -z "$(find /target -mindepth 1 -print -quit)"; tar -C /target --strip-components=1 -xzf /backup/one.tar.gz'
```

如果备份中存在 `dist.tar.gz`，还应保留客户端当前使用的 Planet：

```bash
sudo docker volume create ztplanet_ztnet-planet
sudo docker run --rm \
  -v ztplanet_ztnet-planet:/target \
  -v "$legacy_backup:/backup:ro" \
  alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
  sh -eu -c 'mkdir -p /tmp/legacy /target/zt-mkworld; tar -C /tmp/legacy -xzf /backup/dist.tar.gz; cp /tmp/legacy/dist/planet /target/planet; cp /tmp/legacy/dist/planet /target/zt-mkworld/planet.custom; chown -R 1001:1001 /target; chmod -R u=rwX,g=rX,o= /target'
```

再由 1Panel 启动 `ztplanet` 编排。如果启动失败，在 1Panel 停止新版编排，然后恢复：

```bash
sudo docker start myztplanet
```

旧容器和旧数据目录在验收完成前不得删除。

## 七、迁移到另一台 ARM64 VPS

在旧机完成第五节并保持 `myztplanet` 停止，通过 SCP/SFTP 将整个校验过的备份目录传到
新机，例如 `/var/backups/ztplanet-legacy/before-v1.1.0`。在新机先验证：

```bash
cd /var/backups/ztplanet-legacy/before-v1.1.0
sudo sha256sum -c SHA256SUMS
```

然后完成第二节的准备、创建 `ztplanet_zerotier-data` 并按第六节导入，最后由 1Panel
创建并启动编排。

旧、新 Controller 绝不能同时运行同一份 ZeroTier 私有身份。如果新 VPS 的公网 IP 或
ZeroTier UDP 端口改变，必须重新生成并向客户端分发 Planet/Moon；公网 IP、端口和身份
完全保持时，现有客户端才可能继续无感使用原 Planet。

## 八、ZTNCUI 到 ZTNet 的数据边界

旧 ztNCUI 用户名和密码不会迁移。首次进入新版后注册强管理员，再进入
**Admin → Controller → Unlinked networks**，把旧网络分配给新管理员。

Controller 的网络 ID、成员、授权状态、路由、地址池和 Flow Rules 位于 `controller.d`，
随 `one` 数据迁移。不要恢复旧匿名文件服务器或查询字符串下载 Key。

## 九、以后升级新版 Compose

本节只适用于已经运行本项目 ZTNet 分离栈的服务器，不适用于旧 `myztplanet`。

1. 在管理机执行 `/opt/ztplanet/scripts/manage.sh backup`；
2. 确认目标版本五个多架构标签和安全流水线已成功；
3. 克隆目标 Git 标签到新目录；
4. 执行新版本的 `prepare-1panel.sh`，它保留 `/etc/ztplanet` 和命名卷；
5. 在 1Panel 编辑编排，将 `ZTPLANET_RELEASE` 改为目标版本；
6. 点击“拉取/重建”并检查全部容器健康状态。

不要使用 `latest`，也不要只更新其中一个组件。回滚时恢复升级前备份并将五个镜像一起
改回原版本。

## 十、验收

```bash
sudo /opt/ztplanet/scripts/manage.sh status
sudo /opt/ztplanet/scripts/manage.sh backup
docker ps --filter label=com.docker.compose.project=ztplanet
sudo ss -lntup
```

核对旧网络 ID、路由、地址池、规则、成员和授权状态。至少使用一台可丢弃客户端验证
`DIRECT`、UDP `RELAY`、TCP `TUNNELED` 和关闭 fallback 的故障矩阵。验收成功后让旧
容器继续保持停止，至少经过一个正常备份周期后再考虑清理。
