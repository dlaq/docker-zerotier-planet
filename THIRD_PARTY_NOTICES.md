# 第三方软件声明

- ZTNet 的版权归其贡献者所有，采用 GPL-3.0 许可证。完整许可证位于
  `services/ztnet/LICENSE`，修改后的源代码随本项目放在 `services/ztnet`。
- ZeroTier One 使用混合许可证。MPL 覆盖部分采用 `LICENSE-MPL.txt`；Controller
  及其他源码可用部分受固定版本源码中的 `nonfree/LICENSE.md` 约束。构建过程会把
  两份声明复制到 `/usr/share/doc/zerotier`。本发行版仅面向用户声明的个人、
  非商业自建用途；改变用途前必须重新核对上游最新许可证。
- Caddy、PostgreSQL、Debian、Node.js、Rust 和 JavaScript 软件包分别保留各自的
  上游许可证。持续集成安全门禁会为最终容器镜像生成 SPDX JSON SBOM。
- `services/relay` 单独采用 MIT 许可证。

本项目中用于修改和集成 ZTNet 的部署与配置代码采用 GPL-3.0-only；完整 GPL 文本
见 `services/ztnet/LICENSE`。
