# 生产部署与旧版迁移

本文适用于原项目的 `myztplanet` 容器和新版 ZTNet 拆分架构。不要再次运行旧版
安装脚本：它的安装流程会先删除 `data/zerotier`。

## 一、发布到 Docker Hub

GitHub 仓库必须配置以下 Actions Secret：

- `DOCKERHUB_USERNAME`：Docker Hub 用户名；
- `DOCKERHUB_PASSWORD`：Docker Hub Access Token，不是账户明文密码。

再配置普通 Actions Variable：

- `DOCKERHUB_REPOSITORY`：单个镜像仓库名；未配置时沿用旧工作流中的
  `zerotier-planet-test`。

Access Token 必须放在 **Secrets**，不能放在普通 Variables。若曾经以普通变量保存，
应立即撤销旧 Token 并重新生成。如果准备改用正式名称，可先在 Docker Hub 创建新的
私有仓库（例如 `zerotier-planet`），再把 `DOCKERHUB_REPOSITORY` 设置为该名称；Token
权限应限制为目标仓库的读写权限。

推送 `v*` Git 标签后，`.github/workflows/security.yml` 会依次执行源码测试、五个镜像
构建、Medium/High/Critical 漏洞扫描和 SBOM 生成。只有全部通过才会登录 Docker Hub，
发布以下五个标签：

```text
用户名/仓库:zerotier-v1.0.0
用户名/仓库:ztnet-v1.0.0
用户名/仓库:relay-v1.0.0
用户名/仓库:postgres-v1.0.0
用户名/仓库:gateway-v1.0.0
```

也可以在 GitHub Actions 手动运行“安全门禁与 Docker Hub 发布”，勾选发布并填写版本。不要复用或
覆盖旧版本标签。

当前流水线只发布 Linux AMD64 镜像。生产机可用 `uname -m` 检查架构；输出应为
`x86_64`。ARM64 主机必须先扩展并验证多架构构建，不能直接使用本版镜像。

## 二、生产机从 Docker Hub 安装

生产机仍需取得相同 Git 标签中的部署脚本和 Compose 文件，但不会在生产机编译镜像。
若 Docker Hub 仓库是私有的，先交互式登录，提示输入密码时粘贴 Access Token：

```bash
sudo docker login --username DOCKERHUB_USERNAME
```

然后安装：

```bash
git clone --branch v1.0.0 --depth 1 \
  https://github.com/dlaq/docker-zerotier-planet.git \
  /srv/ztplanet-v1.0.0

cd /srv/ztplanet-v1.0.0
sudo ./deploy.sh install-dockerhub DOCKERHUB_USERNAME/zerotier-planet-test v1.0.0
```

安装器会把精确镜像引用写入 `/etc/ztplanet/images.env`，拉取包括默认关闭的 TCP 中继
在内的五个镜像，并使用 `--no-build` 启动。数据库和登录密钥随机生成在
`/etc/ztplanet/runtime.env`，不会从 Docker Hub 或 GitHub 下发。

检查状态：

```bash
sudo /opt/ztplanet/scripts/manage.sh status
sudo docker ps --filter name=ztplanet
sudo cat /etc/ztplanet/images.env
```

升级到新版本时，先确认新标签的流水线和五个镜像均已发布，再从新版本源码目录执行：

```bash
sudo /srv/ztplanet-v1.1.0/deploy.sh \
  upgrade-dockerhub DOCKERHUB_USERNAME/zerotier-planet-test v1.1.0
```

升级会先备份数据库、Controller 身份、Planet 工作区、配置和旧发布文件；拉取或启动
失败时自动尝试恢复旧发布与数据。

## 三、首次安全访问

默认管理端只监听 `https://127.0.0.1:3443`。在管理电脑建立 SSH 隧道：

```bash
ssh -N -L 3443:127.0.0.1:3443 管理用户@生产机IP
```

浏览器打开 `https://127.0.0.1:3443`，确认并接受预期的自签名证书警告。第一个注册
账户成为管理员，随后开放注册自动关闭。

进入 **Admin -> System & Exposure（系统与暴露面）** 后：

- 保留回环监听，或添加明确的局域网 IP；
- 为两个可信内网填写准确 CIDR；
- 保持自签名 HTTPS，或安装用户证书；
- ZeroTier 接口出现后，按需开启虚拟网访问管理端；
- 把 ZeroTier UDP 监听端口设置为旧生产端口；
- Controller API 默认保持仅内部访问；
- TCP fallback 默认关闭，需要时再配置独立端口、来源 CIDR 和限额。

TCP/9993 不是 TCP fallback。公网通常只开放 ZeroTier UDP 端口；管理端优先通过 SSH、
内网或 ZeroTier 访问。若启用 TCP 中继，只开放用户选定的中继 TCP 端口。

## 四、迁移前只读盘点

修改旧生产机前先执行：

```bash
docker inspect myztplanet \
  --format '{{range .Mounts}}{{println .Destination " <- " .Source}}{{end}}'
docker inspect myztplanet \
  --format 'image={{.Config.Image}} running={{.State.Running}}'
docker port myztplanet
sudo du -sh /旧仓库准确路径/data/zerotier
```

必须确认 `/var/lib/zerotier-one` 的真实宿主机来源。原项目通常对应
`旧仓库/data/zerotier/one`，但不能只根据容器名猜测。

## 五、制作独立旧版备份

在维护窗口执行，并把占位路径改为盘点得到的准确路径：

```bash
legacy_repo=/旧仓库准确路径
legacy_backup=/var/backups/ztplanet-legacy/迁移前备份

sudo install -d -m 0700 "$legacy_backup"
docker stop --time 30 myztplanet
sudo tar --numeric-owner -C "$legacy_repo/data/zerotier" -czf "$legacy_backup/one.tar.gz" one
sudo tar --numeric-owner -C "$legacy_repo/data/zerotier" -czf "$legacy_backup/dist.tar.gz" dist
sudo tar --numeric-owner -C "$legacy_repo/data/zerotier" -czf "$legacy_backup/config.tar.gz" config
sudo tar --numeric-owner -C "$legacy_repo/data/zerotier" -czf "$legacy_backup/ztncui.tar.gz" ztncui
(cd "$legacy_backup" && sudo sha256sum one.tar.gz dist.tar.gz config.tar.gz ztncui.tar.gz | sudo tee SHA256SUMS)
(cd "$legacy_backup" && sudo sha256sum -c SHA256SUMS)
docker start myztplanet
```

另存一份离线副本。`one.tar.gz` 包含 Controller 身份、Token、网络和成员配置；
`dist.tar.gz` 包含客户端正在使用的 Planet/Moon。这两类备份都按密钥材料保护。

## 六、同机迁移

新版放在不同目录，不覆盖旧仓库。将旧 Controller 状态复制到新版源码目录，安装器会
识别并导入：

```bash
new_release=/srv/ztplanet-v1.0.0
legacy_repo=/旧仓库准确路径

sudo install -d -m 0750 "$new_release/data/zerotier"
sudo cp -a "$legacy_repo/data/zerotier/one" "$new_release/data/zerotier/one"
cd "$new_release"
sudo ./deploy.sh install-dockerhub DOCKERHUB_USERNAME/zerotier-planet-test v1.0.0
```

安装器会停止运行中的 `myztplanet`、额外制作时间戳备份、把数据导入
`ztplanet_zerotier-data`，再启动新栈；失败时重新启动旧容器。旧仓库和旧容器不会删除。

旧 ztncui 用户和密码不会导入。注册新的强管理员后，进入
**Admin -> Controller -> Unlinked networks**，把原 Controller 中的网络分配给新管理员。
网络 ID、成员授权、路由、地址池和 Flow Rules 保存在 Controller 数据中，会随
`controller.d` 保留。

验证期间可把原 Planet 原样复制到 ZTNet 独立工作区：

```bash
legacy_dist=/旧仓库准确路径/data/zerotier/dist
sudo docker run --rm \
  -v ztplanet_ztnet-planet:/target \
  -v "$legacy_dist:/legacy:ro" \
  alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce \
  sh -eu -c 'mkdir -p /target/zt-mkworld; cp /legacy/planet /target/zt-mkworld/planet.custom; cp /legacy/planet /target/planet; chown -R 1001:1001 /target; chmod -R u=rwX,g=rX,o= /target'
```

旧 `.moon` 文件继续保存在备份中，只通过 SSH/SCP 等认证渠道分发，不得恢复旧匿名
文件服务器和查询字符串 Key。

如果公网 IP、UDP 端口和导入身份都不变，现有客户端可继续使用旧 Planet。若公网 IP
或端口改变，必须重新生成并分发 Planet/Moon。

## 七、跨机迁移

通过 SCP/SFTP 把已校验的旧版备份传到新服务器。`one.tar.gz` 已包含顶层 `one` 目录，
应解压到新版源码的 `data/zerotier` 下，再执行 Docker Hub 安装。安装完成后按同机步骤
复制旧 Planet。

旧、新服务器绝不能同时运行同一份 ZeroTier 私有身份。启动新 Controller 前必须停止
旧容器。新服务器公网地址不同时，应预先安排客户端 Planet 替换和回滚窗口。

## 八、切换前验收

```bash
sudo /opt/ztplanet/scripts/manage.sh status
sudo /opt/ztplanet/scripts/manage.sh backup
sudo docker ps --filter name=ztplanet
sudo ss -lntup
```

核对旧网络 ID、路由、地址池、规则、成员和授权状态。先用一台可丢弃客户端测试旧
Planet，再执行安全审计报告中的 `DIRECT`、UDP `RELAY`、TCP `TUNNELED` 和关闭
fallback 矩阵。

验收成功后才让旧容器保持停止。至少经过一个正常备份周期后，再考虑清理旧环境。
