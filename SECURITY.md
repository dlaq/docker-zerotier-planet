# 安全策略

请勿在公开问题中提交身份文件、Controller Token、数据库备份、私钥、Cookie
或可直接利用的漏洞细节。发现疑似漏洞时，请通过私密渠道联系仓库所有者，并说明
受影响提交、部署配置、复现步骤和影响。

本项目只支持固定版本的正式发布。服务暴露前必须运行
`scripts/security-gate.sh --containers`，并审阅 `docs/SECURITY-AUDIT.md`。
一旦怀疑发生泄漏，应立即轮换 Controller Token、认证密钥和相关证书。

TCP fallback 的外层封装不是真正的 TLS，也没有协议级客户端认证。允许任意来源访问
TCP 中继属于用户明确确认的高风险配置，不是安全默认值。
