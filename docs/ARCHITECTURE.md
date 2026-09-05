# 架构与信任边界

```text
互联网 / 局域网 / ZeroTier 接口
          | 用户选择的 TCP 监听器
          v
 Caddy 管理网关（宿主网络，无 Docker Socket）
          | 回环 TCP/3000
          v
 ZTNet（非特权）---- Unix Socket + HMAC ----> root 配置代理
          | 内部 HTTP                              | 仅固定类型操作
          v                                        v
 ZeroTier Controller <---- 内部网络 ---- 生成配置 / Compose
          |
 PostgreSQL（仅内部网络）

可选公网 TCP --> 中继（独立网络）--> 仅公网单播 IPv4 UDP
                                      宿主机 DOCKER-USER 出站过滤
```

ZTNet 是主管理应用。它没有 Docker Socket、宿主机根目录挂载、防火墙权限或任意
命令接口。root 配置代理只通过权限为 0660 的 Unix Socket 接受严格 JSON Schema
和固定端点。每个请求都包含时间戳、Nonce、HMAC、正文大小限制和重放检测。应用配置时
会检查版本号和幂等键，使用原子文件、受限 Compose 参数、健康检查和自动回滚。

密钥以 root 所有文件保存在 `/etc/ztplanet`。Web 容器只通过精确的只读文件挂载
获得代理 HMAC 密钥。Controller 状态以只读方式挂载到
`/run/zerotier-controller`；Unix 权限仅允许 ZTNet 读取组可读的 API Token 和
公有身份。可写 Planet 工作区使用独立的 `./data/ztnet-planet` bind 目录；这些目录默认由
root 创建并限制为 0750，启动初始化任务再把必要的目录交给对应服务 UID。TLS 私钥仅允许
管理网关的专用数字 GID 读取，不写入 PostgreSQL，也不会从状态 API 返回。

管理网关负责用户选择的外部监听器，ZTNet 原始端口始终只发布到宿主机回环地址。
通配监听器可能已经包含 ZeroTier 接口；生效监听器视图会报告这一事实，不会再建立
冲突的重复绑定。

TCP 中继使用独立网桥，无法路由到应用网桥，没有共享卷、密钥和 Capability；根文件
系统只读，并启用系统调用白名单、资源限制和宿主机出站链。中继协议没有客户端认证，
因此即使 overlay 数据已加密，来源 CIDR 和保守限额仍然非常重要。回包字节额度与
双向速率限制用于约束 UDP 响应放大。

Docker Hub 部署只改变镜像来源，不改变上述信任边界。AMD64 和 ARM64 使用同一组多架构
标签。生产 `docker-compose.yml` 不包含构建指令，由 1Panel 拉取并编排五个固定组件；
源码构建参数隔离在 `docker-compose.build.yml`。图形界面的配置助手只执行固定 Compose
项目和服务操作，不接受任意 Compose 参数，也不挂载 Docker Socket。
