# P3-C2d4c3a · 原生恢复应答中断与接管导读

本批接续 #116 已核验的 B → A，固定代码为 `9f9c5ebdf5cbc2109fb21052a1e9f5a96d4eb3cb`。 [阶段计划](../plans/p3-c-operations-restore.md) · [PR #117](https://github.com/MaLaNg116/itervane/pull/117)

1. 在同一实验应用停止已恢复的 A。运维 Agent 以恢复后的实例为当前目标，重新形成恢复至已核验版本 B 的提案，沿用门户本人确认与幂等提交。 [联验场景](https://github.com/MaLaNg116/itervane/blob/9f9c5ebdf5cbc2109fb21052a1e9f5a96d4eb3cb/packages/control-plane/test/native/worker-inspection.ts#L1127)
2. 一次性 PostgreSQL 中的测试触发器只阻塞本次处置的部署回执。通过实际 Komodo Read 身份和本机容器证据确认 B 已运行，然后终止执行 Worker。继任进程以新代次读取原操作。缺少原生更新回执时，任务呈现待人工核对，持久化环境占用并释放全局槽。 [应答中断夹具](https://github.com/MaLaNg116/itervane/blob/9f9c5ebdf5cbc2109fb21052a1e9f5a96d4eb3cb/packages/control-plane/test/native/operations-acknowledgement-barrier.ts#L18) · [接管断言](https://github.com/MaLaNg116/itervane/blob/9f9c5ebdf5cbc2109fb21052a1e9f5a96d4eb3cb/packages/control-plane/test/native/restore-proof.ts#L183)
3. 接管前后回读同一个 B 容器，入库配置回执保留，部署回执为空。冲突发布仍被环境占用拒绝。中英文 HTTP 与 MCP 显示同一待人工结果，当前已核验发布仍指向先前验证过的 A。 [托管断言](https://github.com/MaLaNg116/itervane/blob/9f9c5ebdf5cbc2109fb21052a1e9f5a96d4eb3cb/.github/workflows/native-runner.yml#L239)

TypeScript、248 项单元、Bash 语法和既有重启中断夹具的 PostgreSQL 17.12 回归通过。实际终止与接管由托管 `protected-release-restore` 验收。后续覆盖手中已有原生更新编号的接管、审批过期、撤销、登记漂移与参考安装。 [托管检查](https://github.com/MaLaNg116/itervane/pull/117/checks)
