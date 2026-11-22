# P3-C2d4c3c · 版本恢复的失效批准与目标变化导读

本批接续 #118，固定代码为 `d4b1890ec24736afa10e9800ab79e80823d8f113`。 [阶段计划](../plans/p3-c-operations-restore.md) · [PR #119](https://github.com/MaLaNg116/itervane/pull/119)

1. 新场景发布同一受保护应用的 A 和 B。独立 Komodo Read 身份确认 B 的停止快照，Whiskers 与运维 Agent 为每次演练分别记录诊断和审批。 [固定测试目标](https://github.com/MaLaNg116/itervane/blob/d4b1890ec24736afa10e9800ab79e80823d8f113/packages/control-plane/test/native/worker-inspection.ts#L1115)
2. 第一项由原批准人在派发前撤销。第二项以 PostgreSQL 时钟自然经过已配置的 60 秒批准窗口，并由正式 Worker 处理到期队列。断言旧提交被拒、写步骤为零、全局执行槽和环境占用已释放，同时核对 B 的停止快照保持一致。 [撤销与到期断言](https://github.com/MaLaNg116/itervane/blob/d4b1890ec24736afa10e9800ab79e80823d8f113/packages/control-plane/test/native/restore-proof.ts#L288)
3. 第三项在审批后由测试维护者重新启动同一个 B 容器，模拟平台外的目标状态变化。检查恢复写步骤为零、实际 B 和 Komodo 配置一致、未知处置保留占用，以及中英文 HTTP 和 MCP 回执一致。 [托管断言](https://github.com/MaLaNg116/itervane/blob/d4b1890ec24736afa10e9800ab79e80823d8f113/.github/workflows/native-runner.yml#L221)

TypeScript、248 项单元、两个 Bash 脚本的语法和差异检查通过。原生负例及其归档由 `protected-release-restore-authorization` 验收。同一矩阵继续验证正向恢复及两个接管分支。 [托管检查](https://github.com/MaLaNg116/itervane/pull/119/checks)

交付提交 `e83b0cefbd82cfffb18e996f4d3e00a7ca43f64d` 的专用任务通过，报告源码指纹为 `2dd62d02e56725d115ccf462f12e1c7f4b7d4c4abd8eadc168526e84d1b893df`。三种负例均保留原容器、记录零写步骤，并释放全局槽。派发前撤销与过期释放环境。原生目标变化保留人工核对占用。三个中英文 HTTP/MCP 结果都一致。 [原生任务](https://github.com/MaLaNg116/itervane/actions/runs/45046420679/job/137281922347) · [归档](https://github.com/MaLaNg116/itervane/actions/runs/45046420679/artifacts/14763909715)
