# 上游维护策略

本发行版直接以 ZTNet 作为管理应用，不再维护第二套重复的网络管理界面。

- ZTNet 源码：`https://github.com/sinamics/ztnet`
- 固定基线：`19206f20917de5e75c3f378c732e275f0a3b16ae`
- 本仓库位置：`services/ztnet`
- ZeroTier One 源码：`https://github.com/zerotier/ZeroTierOne`
- 固定基线：`1.16.2`，提交 `fc5c3ec22090b5b2a0f274e863651fe9ca489bf4`

长期维护时，应建立 ZTNet 的 GitHub Fork，并把 `services/ztnet` 中的修改维护在
该 Fork。宿主机配置代理、TCP 中继和 Compose 发行文件继续保留在本仓库或相邻的
部署仓库中。这样既方便审阅 ZTNet 上游合并，也能确保特权宿主机操作不进入 Web 进程。

更新任一固定版本前，必须审阅发行说明和许可证变化，重新生成锁文件与 SBOM，
并执行 `docs/SECURITY-AUDIT.md` 中的完整安全门禁。源码构建不得跟随移动分支或
`latest` 标签；正式部署只使用与 Git 提交对应的不可变发行标签。
