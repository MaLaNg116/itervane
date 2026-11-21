# P2-E-D3-D2 · 同一发布操作的端到端验证

接续 [#60](https://github.com/MaLaNg116/itervane/pull/60) 的隔离应用网络。从已固定并完成修复的 KVM 源码任务出发，以外部 MCP 请求发布，以门户身份确认，再由正式安装入口启动发布 Worker。 [总计划](p2-e-protected-release-e2e.md)

1. D2-A 建立可复用的测试入口。复用自托管 Compose 的管理网、认证网和内部应用网。使用固定 Traefik 和 OAuth2 Proxy、真实 Keycloak 与短时探测身份，在测试专用目录配置 TLS 证书，验证匿名拒绝、身份范围及令牌有效期上界。保持管理 API 只读、应用无宿主端口、认证服务不可由应用网络访问。
2. D2-B 增加独立的托管 KVM 端到端场景。复用固定的合成仓库和正式 Worker 的修复与独立复验，在注册真实入口后由 MCP 冻结候选、独立门户身份提交人工决定，运行安装态发布 Worker。真实 Registry、Komodo 更新、受保护入口和 PostgreSQL 持久化结果都使用同一操作。比对 HTTP 与 MCP 双语结果、镜像摘要、更新 ID、应用版本和真实 TLS 健康。
3. 分开保存脚本模型与真实模型的证据。托管运行仅使用合成应用、临时身份、限定目标和测试证书。退出时先停 Worker，再清理入口、发布目标、Registry 和数据库。保留四组现有 KVM 回归原有断言。

D3 将验收第二类修复、审批后漂移、入口故障以及进程中断。完整 P2 的验收范围见 [实施计划](../implementation-plan-v2-ts-postgresql.md#p2-跑通-agent-审计修复复验和发布)。
