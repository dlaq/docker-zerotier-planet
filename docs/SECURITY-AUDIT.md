# 安全审计报告

审计日期：2026-09-05。范围：本次交付源码、五个 Linux/amd64 与 Linux/arm64 生产
容器镜像、ARM64/1Panel Compose 发布设计及 Docker Hub 正式多架构清单。
本报告不能替代目标主机防火墙、DNS、证书、端口映射和后续依赖变化的重新审计。

## 发布结论

**v1.1.0 双架构发布门禁通过。** GitHub Actions 运行
[`33961011358`](https://github.com/dlaq/docker-zerotier-planet/actions/runs/33961011358)
使用原生 AMD64 与 ARM64 runner 分别构建和扫描五个镜像，两个架构均未检出 Medium、
High 或 Critical 漏洞，并分别生成 SPDX SBOM。正式多架构标签仅由这两组已扫描镜像
合成，发布任务最终状态为 `Success`。
需要两台客户端和故障注入的公网/NAT 网络矩阵仍须在目标机完成。

公网或通配管理监听、明文 HTTP、直接暴露 Controller、允许任意来源访问 TCP 中继
仍由用户决定。界面会标记风险、要求管理员重新验证密码并记录审计事件；用户确认风险
不等于该部署自动变得安全。

## 可复现门禁结果

| 门禁 | 结果 |
|---|---|
| 宿主机配置代理 | 通过：13/13 单元测试及 Python 编译 |
| Rust TCP 中继 | 通过：rustfmt、Clippy 零警告、6/6 单元测试、2/2 协议测试 |
| ZTNet 页面 | 通过：12 个测试套件，59/59 |
| ZTNet API | 通过：35 个测试套件，352/352 |
| ZTNet 生产构建 | 通过：TypeScript、Next.js 生产构建、130 个页面 |
| ZTNet 依赖审计 | 通过：完整 npm audit，0 项 |
| ztmkworld | 通过：`go test ./...`、`go vet ./...` |
| 密钥扫描 | 通过：Gitleaks 未发现泄漏 |
| IaC/容器配置 | 通过：Trivy Medium/High/Critical 为 0 |
| 源码与锁文件 | 通过：Trivy 漏洞和密钥扫描 Medium/High/Critical 为 0 |
| Compose 模型 | 通过：变量插值及 `docker compose config --quiet` |
| ARM64 构建定义 | 通过：Node/Prisma 运行层按目标架构构建，基础镜像均提供 ARM64 清单；CI 使用 GitHub 原生 ARM64 runner，避免 QEMU 执行 Node 原生模块 |
| 多架构发布门禁 | 通过：AMD64/ARM64 在各自原生 runner 构建、扫描并推送架构标签，两边全部通过后合成正式 manifest |
| 配置代理 systemd 沙箱 | 通过：离线暴露评分 4.0/10，结果 `OK` |
| 最终容器镜像 | 通过：五个镜像 Medium/High/Critical 均为 0 |
| SPDX SBOM | 通过：五个最终镜像均已生成 |

源码目录中的 systemd 可执行路径检查会提示 `/opt/ztplanet` 尚不存在，这是因为该目录
由安装器创建。离线沙箱分析有效，正式安装后仍应再次验证服务状态。`UMask=0027` 是
有意设置，用于允许 ZTNet 和网关的专用组读取指定生成文件。

## 最终镜像证据

Docker Hub 正式标签的清单摘要与平台如下；这些摘要来自发布完成后的仓库 API 验证：

| 正式标签 | 多架构清单摘要 | 平台 |
|---|---|---|
| `zerotier-v1.1.0` | `sha256:51be0704376cf67b77f88ecf4544eae9793eeeae9d15947bf167b29154eb086c` | amd64、arm64 |
| `ztnet-v1.1.0` | `sha256:2db7564eaa8d9fa4909582f7cc254ae783d42e4fd5b064e907c202182286ce33` | amd64、arm64 |
| `relay-v1.1.0` | `sha256:01b1391d565d15dff7486cd8a1631781acd1d354d92e77a188a3f17078a8dc34` | amd64、arm64 |
| `postgres-v1.1.0` | `sha256:6ea416f2fb99986e165f4930abdd28fe0c736def0c84e229513fcac8b6e1f401` | amd64、arm64 |
| `gateway-v1.1.0` | `sha256:449c826588895579f6d00356849ed20422fffe5904139c9621ca22de76159131` | amd64、arm64 |

以下本地 AMD64 镜像 ID 是发布前同一源码的补充扫描证据，不是 Docker Hub 清单摘要：

| 镜像 | 本地镜像 ID | 内容大小 | Medium | High | Critical |
|---|---|---:|---:|---:|---:|
| `ztplanet-zerotier:latest` | `sha256:5a84134d3704b28c91c697b6944b984e7f87434f965ada263e97fbefd18b2aa8` | 23,815,997 B | 0 | 0 | 0 |
| `ztplanet-ztnet:latest` | `sha256:3e4760e1ed1998ce540ab28d4c7795bdca265dd4458312c4e210c53de49156ed` | 433,389,639 B | 0 | 0 | 0 |
| `ztplanet-gateway:2.11.4` | `sha256:cd06a2c405bbfeb0bf75e3740495a7bc493b031850a7d23f217a5e6132a40099` | 19,182,302 B | 0 | 0 | 0 |
| `ztplanet-postgres:17` | `sha256:35a534a916f8bf176ad2cd204497f32871366cf9bbb0899ce30cfcbfdef084bb` | 116,281,737 B | 0 | 0 | 0 |
| `ztplanet-relay:latest` | `sha256:ecf26836f78d492205ae4c5782013a6f2d0c7d9b04f9bb8d9c0db801b9d22e55` | 266,930 B | 0 | 0 | 0 |

第二张表是本地 Docker 镜像 ID，不是 Docker Hub 清单摘要。重新构建会产生新 ID，必须
重新扫描并生成 SBOM。ZeroTier 运行镜像使用 `scratch`、静态 BusyBox 和 `ldd`
实际依赖库，同时保留最小 Debian 包版本记录，避免扫描器因缺少包管理元数据产生假阴性。

## 隔离运行检查

- ZeroTier 在断网、只读根文件系统、`no-new-privileges` 和最小能力集下启动，报告
  `1.16.2`，Controller 认证端点正常返回。
- 固定源码构建期间，ZeroTier 上游身份、证书、Salsa20、Poly1305、SHA-512、
  C25519/Ed25519、报文、UDP 和 TCP 自测试全部通过。
- ZTNet 以 UID/GID 1001、只读根文件系统、Capability 全清零运行。54 个 Prisma
  迁移和 Seed 在 PostgreSQL 17.11 上完成，登录页返回 200。
- 匿名访问 `/admin` 跳转登录；Planet/mkworld 返回 401；缺少 `x-ztnet-auth` 的
  REST API 返回 401，并有回归测试覆盖。
- Caddy 以 UID/GID 1002 只读运行。自签名 HTTPS 返回 HTTP/2、HSTS、nosniff、
  禁止 iframe、no-referrer 和限制性 Permissions-Policy，并移除 Server 头。
- Compose 持久化存储均为编排目录下的 `./data/*` bind 挂载，不声明 Docker named volume；
  `ztnet-init` 和 `gateway-init` 以最小 `CHOWN` capability 修正目录属主。ZTNet 只通过
  `root:1001/0640` 读取 `authtoken.secret`、`identity.public` 和 `planet`，不会获得
  ZeroTier `identity.secret` 的读取权限。
- TCP 中继以 UID/GID 65532、只读根文件系统、零 Capability、自定义 seccomp 和
  资源限制运行。健康及指标端点正常，实际访问 `169.254.169.254` 被拒绝并计数。
- PostgreSQL 17.11 精简镜像可启动、迁移并接受数据库连接。

## 本次修复的主要问题

- 删除匿名文件服务器、查询字符串 Token 和默认密码。
- 将单个特权容器拆为 ZTNet、PostgreSQL、网关、Controller、宿主机代理和可选中继。
- 升级 Node 依赖至完整 npm audit 为 0，运行镜像移除 npm/npx。
- 禁止 ZTNet 应用内任意数据库恢复路径；限制 Planet/mkworld 为管理员访问。
- 密码长度至少 14 位，bcrypt cost 12，启用登录锁定、八小时会话上限和安全 Cookie。
- 宿主机操作使用 HMAC、Nonce、重放保护、版本与幂等校验、路径和参数白名单、原子写入
  及失败回滚。
- TCP 中继增加严格帧解析、Slowloris 绝对超时、尺寸限制、公网单播目标限制、回包来源
  校验、响应额度、全局/单连接限速、seccomp 和宿主机出站过滤。
- Caddy 升至固定源码 2.11.4，并升级相关 Go 模块和应用兼容补丁。
- PostgreSQL 运行层替换旧 `gosu`、使用 `su-exec` 并扁平化，避免携带无关历史包。
- 修复最小 ZeroTier 镜像数字属主和依赖元数据审计透明度。
- 修复 ZTNet REST API 缺少 Token 时返回未捕获 500 的问题，现返回 401。
- 新增可直接粘贴到 1Panel 的独立 Compose：固定多架构清单摘要、强制实例独立密钥、
  内嵌自签名 HTTPS 配置且不依赖宿主机文件或 Docker Socket。

## 生产环境仍需完成的验收

本审计未修改公网端口、路由器映射或真实主机防火墙。目标机应再次执行
`sudo ./scripts/security-gate.sh --containers`，并用两台可丢弃客户端验证：

1. 正常 UDP：状态为 `DIRECT`；
2. 打洞失败但根节点 UDP 可达：业务通过 `RELAY` 连通；
3. UDP 全部阻断且启用自建非 443 中继：等待 fallback 后为 `TUNNELED`；
4. UDP 全部阻断且关闭 fallback：按预期失败并给出明确诊断；
5. `custom-force` 仅用于用户主动选择的诊断测试。

还必须在目标机实际验证回环、两个私网地址、所选 ZeroTier 地址、指定公网地址和通配
监听器，以及 HTTP、自签名 TLS 和用户证书。依赖、镜像、监听器、证书、内核、Docker、
防火墙或中继限额发生变化后，本报告对应部分失效，必须重新审计。
