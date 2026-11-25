# P4-D3c · 后续运维任务复用已发布 Runbook

本批在同一个受保护镜像上使用三次独立停机观测。首个任务核验恢复并生成 Runbook。后续任务引用原已发布版本，分别验证成功恢复和回执中断。 [本批计划](../plans/p4-native-runbook-reuse.md) · [#155](https://github.com/MaLaNg116/itervane/pull/155)

1. `ce32e93` 在现有原生 Whiskers 重启流程中核对 HTTP、外部 MCP 和数据库读取到的任务规则快照、诊断引用和呈批版本。分别使用门户确认与原生 Whiskers 浏览器审批。发布摘要和容器 ID 都须一致，启动时间须更新，独立 Komodo 身份及受保护健康回读决定恢复结果。 [Runbook 引用](https://github.com/MaLaNg116/itervane/blob/ce32e93/packages/control-plane/test/native/restart-proof.ts) · [三次停机](https://github.com/MaLaNg116/itervane/blob/ce32e93/packages/control-plane/test/native/worker-inspection.ts)
2. `bf868d5` 保留三组审批、动作、时间、独立回执摘要及任务版本引用。回执中断组要求单次原生发送与无重复写入，保持环境占用并提示人工核对。 [托管判据](https://github.com/MaLaNg116/itervane/blob/bf868d5/.github/workflows/native-runner.yml)

本地 TypeScript、原生测试入口打包、工作流的 3 项 Runbook 判据语法校验通过。完整托管验收使用实际 PostgreSQL、KVM 交付制品、Komodo、Whiskers、浏览器与 Keycloak 受保护入口，控制面审批身份由签名测试服务提供，模型使用 Anthropic 协议夹具。
