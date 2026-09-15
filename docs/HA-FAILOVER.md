# Controller/Planet 主备切换

主备采用人工确认的 active-passive 模式。两台 VPS 保存同一份 Controller 数据、Controller
身份和逐字节相同的 Planet；任意时刻只能有一台运行 `zerotier`、ZTNet、gateway 和 relay。
备机可以保留停止的容器和数据目录，切换时不重新生成身份，也不要求客户端重新加入网络。

Planet 是客户端信任的根配置，不是每台机器各自生成的一份独立配置。若要让客户端同时
知道两个 Planet 根地址，必须先用两台根节点身份生成一份包含两个根地址的 Planet，再把
这同一文件分发到两台机器和客户端；本项目不会在切换脚本中擅自改写或生成 Planet。

## 宿主机配置

在两台机器分别建立 root-only 文件 `/etc/ztplanet/ha.env`，只写普通 `KEY=VALUE`，不要
写 `identity.secret`、数据库密码或登录密码：

```env
ZTPLANET_HA_MODE=primary
ZTPLANET_HA_NODE_ID=vps-a
ZTPLANET_HA_PEER=vps-b
ZTPLANET_HA_STATE_DIR=/etc/ztplanet/ha
ZTPLANET_HA_LEASE_FILE=/shared/ztplanet/active.lease
ZTPLANET_HA_EXPECTED_PLANET_SHA256=<两台都相同的 Planet SHA-256>
```

另一台把 `ZTPLANET_HA_MODE` 设为 `standby`、`ZTPLANET_HA_NODE_ID` 设为不同编号；文件只
支持单独一行的 `KEY=VALUE`，注释请放在独立行。

`ZTPLANET_HA_LEASE_FILE` 应放在两台都能访问的受保护共享位置；如果使用本地路径，它只能
防止同一台机器上的并发操作，不能阻止两台机器同时被人工提升。脚本不会假装实现没有
共识机制的自动故障转移。

## 操作顺序

先在旧主机确认客户端已经无法继续使用该主机，执行：

```bash
sudo /opt/ztplanet/scripts/ha-controller.sh check
sudo /opt/ztplanet/scripts/ha-controller.sh snapshot
sudo /opt/ztplanet/scripts/ha-controller.sh demote
```

把 `snapshot` 生成的备份以受保护方式同步到备机，按 `scripts/restore.sh` 的恢复流程导入
PostgreSQL、Controller 数据和 Planet，确认两个 SHA-256 一致后，在备机执行：

```bash
sudo /opt/ztplanet/scripts/ha-controller.sh check
sudo /opt/ztplanet/scripts/ha-controller.sh promote
sudo /opt/ztplanet/scripts/ha-controller.sh status
```

`promote` 会先取得租约，再启动整套 Compose 并确认 `zerotier` 正在运行；启动失败会释放
租约。`demote` 会停止 gateway、ZTNet、relay、zerotier 和 PostgreSQL，删除只属于本节点
的租约并写入 standby 标记。所有操作都保留 bind 数据，不执行 `down --volumes` 或删除
镜像。租约属于其它节点时脚本会拒绝停止或提升，避免误操作造成双主。

## 客户端与认证说明

客户端认证由 Controller 身份、Planet 和网络成员授权共同决定。只要备机恢复的是同一份
Controller 身份/数据和同一 Planet，公网地址或宿主机端口变化本身不会要求重新授权；如果
生成了新的 Controller identity 或新的 Planet，客户端会把它视为新的根环境，必须重新分发
Planet，并可能需要重新处理成员授权。两个同时运行的不同 Controller 不会自动互相认证，
也不会自动合并网络成员数据库。

主备切换后，ZTNet 会继续从当前可用的 relay 观测端点采集数据。流量记录按
`observerId + bootId` 分开，避免两台机器的计数器重启或切换时相减出负值。
