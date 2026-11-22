# P3-C2d4c3b · 原生更新已落库的恢复接管导读

本批接续 #117，固定代码为 `7b3a6f5e082b241f72b030b658b664564a916da0`。 [阶段计划](../plans/p3-c-operations-restore.md) · [PR #118](https://github.com/MaLaNg116/itervane/pull/118)

1. 同一应用先经批准从 B 恢复 A，再批准 A → B。一次性 PostgreSQL 只暂停这次处置进入核对的状态写入。独立读取确认目标实例运行 B 后终止发送进程，读取其已提交的原生更新编号。原批准人随后撤销权限，旧请求再次提交时收到 409。 [中断与撤销](https://github.com/MaLaNg116/itervane/blob/7b3a6f5e082b241f72b030b658b664564a916da0/packages/control-plane/test/native/restore-proof.ts#L124)
2. 继任进程以更高的代次核验同一原生更新和同一容器。恢复回执绑定 B 的固定镜像、入口保护和健康结果，释放环境和全局执行槽。中英文 HTTP 与 MCP 逐语种比较。 [同一应用验证](https://github.com/MaLaNg116/itervane/blob/7b3a6f5e082b241f72b030b658b664564a916da0/packages/control-plane/test/native/worker-inspection.ts#L1140)
3. 最后再次演练缺少部署回执的 B → A。实际容器运行 A，治理记录保留最后核验的 B，处置继续待人工核对，环境拒绝冲突发布。两类接管使用同一固定目标与入口。 [托管断言](https://github.com/MaLaNg116/itervane/blob/7b3a6f5e082b241f72b030b658b664564a916da0/.github/workflows/native-runner.yml#L239)

TypeScript、248 项单元、11 项 PostgreSQL 17.12 处置接管与围栏专项和差异检查通过。实际进程中断、撤权与恢复结算由托管 `protected-release-restore` 核验。审批过期、发送前撤销、目标变化和公开参考安装继续按 C2d4c3 验收。 [托管检查](https://github.com/MaLaNg116/itervane/pull/118/checks)
