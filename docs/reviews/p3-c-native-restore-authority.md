# P3-C2d4c3c · 版本恢复的失效批准与目标变化导读

本批接续 #118，固定代码为 `d4b1890ec24736afa10e9800ab79e80823d8f113`。 [阶段计划](../plans/p3-c-operations-restore.md) · [PR #119](https://github.com/MaLaNg116/itervane/pull/119)

1. 新场景发布同一受保护应用的 A 和 B。独立 Komodo Read 身份确认 B 的停止快照，Whiskers 与运维 Agent 为每次演练分别记录诊断和审批。 [固定测试目标](https://github.com/MaLaNg116/itervane/blob/d4b1890ec24736afa10e9800ab79e80823d8f113/packages/control-plane/test/native/worker-inspection.ts#L1115)
2. 第一项由原批准人在派发前撤销。第二项以 PostgreSQL 时钟自然经过已配置的 60 秒批准窗口，并由正式 Worker 处理到期队列。断言旧提交被拒、写步骤为零、全局执行槽和环境占用已释放，同时核对 B 的停止快照保持一致。 [撤销与到期断言](https://github.com/MaLaNg116/itervane/blob/d4b1890ec24736afa10e9800ab79e80823d8f113/packages/control-plane/test/native/restore-proof.ts#L288)
3. 第三项在审批后由测试维护者重新启动同一个 B 容器，模拟平台外的目标状态变化。检查恢复写步骤为零、实际 B 和 Komodo 配置一致、未知处置保留占用，以及中英文 HTTP 和 MCP 回执一致。 [托管断言](https://github.com/MaLaNg116/itervane/blob/d4b1890ec24736afa10e9800ab79e80823d8f113/.github/workflows/native-runner.yml#L221)

TypeScript、248 项单元、两个 Bash 脚本的语法和差异检查通过。原生负例及其归档由 `protected-release-restore-authorization` 验收。同一矩阵继续验证正向恢复及两个接管分支。 [托管检查](https://github.com/MaLaNg116/itervane/pull/119/checks)
