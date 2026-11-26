# P5-B4 · 参考环境受保护发布导读

本批使用 P5-B1 的真实控制面安装和 P5-B2 的 KVM Runner。每次从独立安装开始，由外部 MCP 提交项目的固定版本，沿用已有审计、修复、复验、人工审批和原生发布入口。 [本批计划](../plans/p5-reference-release.md) · [参考发布说明](../reference-release-installation.md) · [前置 #164](https://github.com/MaLaNg116/itervane/pull/164)

1. `6b5b510` 为参考联验加入显式 MCP 写范围。在真实 Keycloak 上完成 PKCE，遇到令牌临近过期时使用同一授权刷新。外部 MCP 提交任务并读回审计、实际修复和独立复验。复验核对不同 VM 的回执，锁定修补文件、复验的 OCI 及源码版本。 [安装联验](https://github.com/MaLaNg116/itervane/blob/6b5b510/packages/portal/test/native/reference-install.ts) · [开发交付验收](https://github.com/MaLaNg116/itervane/blob/6b5b510/packages/portal/test/native/reference-release.ts)
2. `6b5b510` 通过现有资源 API 和 CLI 登记真实发布目标。MCP 写令牌尝试确认被拒绝，数据库中保留零条确认前操作。Chrome 使用维护者会话确认指纹后，正式发布 Worker 导入 Registry 并调用 Komodo。成功判据包含真实容器读回、健康和匿名拒绝、双语门户、MCP 与数据库回执一致、全局执行槽释放。 [发布判据](https://github.com/MaLaNg116/itervane/blob/6b5b510/packages/portal/test/native/reference-release.ts)
3. `799240b` 在三个独立托管宿主上分别从空安装运行，保留测试代码树、工作区清理和去重所需的运行标识。测试模型是本地 Anthropic HTTP 响应服务。实际执行侧为 PostgreSQL 17、Keycloak 26.8.2、Chrome、KVM、Registry、Komodo、Traefik 和 OAuth2 Proxy。 [托管流程](https://github.com/MaLaNg116/itervane/blob/799240b/.github/workflows/native-runner.yml)

本地通过严格类型、287 项单测、门户构建、无 Runner 干净安装和 Shell 语法检查。三次完整开发运行的计数以托管作业保存的独立证据为准。参考环境运维、规则复用、故障并发和最终发布判据由后续批次补齐。
