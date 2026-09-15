# 中继会话遥测

本项目现在同时记录两类服务端观测：ZeroTier Controller/Planet 的实际 UDP 发包，以及
TCP fallback relay 的 TCP 会话和 UDP 转发。ZTNet 每 15 秒采集一次已配置的观测端点，写入
PostgreSQL 后在网络成员表显示“中继流量”。表头可以排序，时间范围支持 1 小时、24 小时、
7 天、30 天和全部保留数据。

## 数据从哪里来

ZeroTier 的根节点在 `nodeWirePacketSendFunction` 的成功发送路径记录外层数据包。它只读取
ZeroTier 外层头中的 5 字节 source/destination 节点地址和实际发送字节数，不能解密或验证
overlay 负载。Controller 端点是：

```text
GET /relay/telemetry
X-ZT1-Auth: <Controller authtoken>
```

TCP fallback relay 监听内部指标地址（默认 `0.0.0.0:9090`），额外提供：

```text
GET /relay/telemetry
X-Relay-Telemetry-Token: <RELAY_TELEMETRY_TOKEN>
```

设置 `ZT_RELAY_TELEMETRY_TOKEN` 后，Compose 会把相同值传给 ZTNet 和 relay；relay 端点只在
Docker 内部网络发布，不映射宿主机端口。Prometheus 的 `/metrics` 同时包含活动流和会话
数量，但详细节点流量使用 JSON 端点。

## 返回内容

响应固定带有 `confidence: "wire_observed"`。`flows` 是 source → destination 的累计包数、
字节数、首次/最近观测时间、传输类型和活动标记；`clients` 按节点汇总入站、出站和总字节数。
TCP relay 还会返回 `sessions`：会话编号、来源公网地址、开始/最近活动/关闭时间、到 UDP
和回 TCP 的包数与字节数，以及会话涉及的流数量。所有计数器以十进制字符串传输，避免
JavaScript `Number` 在大数时丢精度。

`transport` 的值为 `udp_relay`、`tcp_relay` 或实现将来增加的值。Controller 的 UDP 观测
表示该节点成功发出了 UDP 包；它不证明该包最终抵达另一端。TCP relay 的观测发生在 TCP
帧成功写入或 UDP 成功发送之后，因此能回答“本 relay 实际转发了多少字节”，但仍不构成
计费凭证。

## 采集、去重和保留

- relay 进程内存保留最近 15 分钟的流和会话，并限制流数量；超出限制会增加
  `droppedFlows`，不会无限增长。
- ZTNet 以 `observerId + bootId` 区分重启前后的计数器。每次采集与上一快照做差，计入
  5 分钟 `RelayTrafficBucket`；计数器回退（进程重启或溢出）会从当前值重新开始，不会
  产生负流量。
- 详细流和会话保留 24 小时，5 分钟汇总保留 90 天。数据库清理在采集事务完成后执行。
- 主备配置可以把两个内部 relay URL 写入 `ZT_RELAY_TELEMETRY_URLS`，任一节点离线不会
  让成员页失败；两个观测端点的结果会按 observer 分开去重。

## 网络成员 API

成员列表请求增加 `relayWindow`，返回每个节点的 `relayBytesIn`、`relayBytesOut`、
`relayBytesTotal`、包数、最近中继时间、置信级别和按传输类型的明细。管理员或有该网络
只读权限的用户可以调用：

```text
network.getRelayTraffic({ nwid, memberId?, window })
network.getRelaySessions({ nwid, window, active? })
```

会话查询的 `networkScope` 为 `node_observed`。relay 协议只携带节点地址，没有网络 ID，
因此服务端先用已观测的 source/destination 与网络成员 ID 关联；无法关联的包保留在
`unattributed`，不会被错误归入某个网络。

## 安全和解释边界

遥测端点默认只在 Controller/relay 内部可达，并沿用 Controller token 或独立 relay token。
不要把端点发布到公网，也不要把 `wire_observed` 当成应用层认证、用户归因或计费数据。
ZeroTier 的 overlay 仍由端到端加密保护；本功能只增加转发路径和流量的运维可见性。
