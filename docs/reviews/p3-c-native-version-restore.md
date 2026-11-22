# P3-C2d4c2 · 同一应用的原生版本恢复导读

本批依赖 #115 的双版本发布，固定代码为 `78d78003f20a0f3612097005d4a73721b81cff00`。 [阶段计划](../plans/p3-c-operations-restore.md) · [PR #116](https://github.com/MaLaNg116/itervane/pull/116)

1. 在同一受保护目标实际停止 B。标签、镜像和容器 ID 限定故障注入范围，独立 Komodo Read 身份回读退出状态。诊断通过真实 Whiskers 读取容器和发布历史，Anthropic 协议的脚本模型依据退出状态及已核验的历史 A 提出恢复。 [诊断与目标核对](https://github.com/MaLaNg116/itervane/blob/78d78003f20a0f3612097005d4a73721b81cff00/packages/control-plane/test/native/worker-inspection.ts#L1060)
2. 用诊断摘要冻结 B → A 提案。测试验证批准前拒绝、门户身份约束和幂等提交，随后在受限账号下启动正式 Restore Worker。PostgreSQL 记录配置、派发及独立核验的租约代次，核对确为获批镜像 A、三次不同的 Komodo 更新、实际容器、健康与访问保护。 [处置断言](https://github.com/MaLaNg116/itervane/blob/78d78003f20a0f3612097005d4a73721b81cff00/packages/control-plane/test/native/restore-proof.ts#L22) · [Worker 装机脚本](https://github.com/MaLaNg116/itervane/blob/78d78003f20a0f3612097005d4a73721b81cff00/fixtures/runner/run-qualified-session.sh#L174)
3. 成功后形成本次恢复的独立核验回执，释放环境与全局执行槽。HTTP 和外部 MCP 逐语种比较回执，随后用同一个 Whiskers 安装再次诊断，核对请求绑定恢复执行和 A 的实际容器。B 留为可查的已核验历史。 [托管断言](https://github.com/MaLaNg116/itervane/blob/78d78003f20a0f3612097005d4a73721b81cff00/.github/workflows/native-runner.yml#L219)

TypeScript、248 项单元、Bash 语法、Restore Worker 打包与 Node 语法检查通过。实际恢复以托管 `protected-release-restore` 的独立回执、发布历史及归档为准。审批过期、权限撤销、目标变化、应答中断、接管和公开参考安装进入 C2d4c3。 [托管检查](https://github.com/MaLaNg116/itervane/pull/116/checks)
