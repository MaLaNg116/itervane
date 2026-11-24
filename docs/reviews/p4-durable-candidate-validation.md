# P4-C2c · 候选验证队列与证据

接续 [#142](https://github.com/MaLaNg116/itervane/pull/142)。准入为 `dc3d6c422fd1260334914119e116550d270eb8ef`，Worker 为 `91e1dd2508e3485bc891032bb057fd6a90e38aa9`。 [实施计划](../plans/p4-durable-candidate-validation.md)

1. 项目成员按候选 ID 和精确提炼摘要请求验证。配置固定 Semgrep 工具、映像及候选内容后，事务写入验证角色任务和队列。Runbook 使用版本化的确定性判据。 [验证准入](https://github.com/MaLaNg116/itervane/blob/dc3d6c422fd1260334914119e116550d270eb8ef/packages/control-plane/src/service/candidate-validations.ts#L58)
2. 占用单槽的 Worker 复查候选和安装，持久化当次域命令及租约。过期执行权不能结算证据，接管先核对工作区空闲。清理未知转人工，误报保留实测失败结果。 [Worker 路径](https://github.com/MaLaNg116/itervane/blob/91e1dd2508e3485bc891032bb057fd6a90e38aa9/packages/control-plane/src/runtime/candidate-validation.ts#L43)
3. PostgreSQL 同时核对工作流、角色、执行槽、当前权限、验证请求与清理回执。结算记录及中英文状态服务于人工评审，正式激活和复用由后续批次处理。 [持久化闸门](https://github.com/MaLaNg116/itervane/blob/bb135a9539f2cc16bb2204f8bab079a1eb553b86/packages/control-plane/migrations/0075_durable_candidate_validation.sql#L126)

本地 TypeScript、Drizzle、274 项单元与 PostgreSQL 17.12 的 5 项候选及来源回归通过。真库覆盖并发、过期租约、误报、错误作用域、清理未知、不可变记录和 Runbook 正反判据。VM 回执在真库用例中使用受控夹具，托管场景使用实际提炼的候选和独立 KVM。模型范围仍是确定性 Anthropic 协议夹具。 [真库用例](https://github.com/MaLaNg116/itervane/blob/b8bfb632f37a283ec977db5c7358b1151385931f/packages/control-plane/test/integration/inspections.test.ts) · [托管检查](https://github.com/MaLaNg116/itervane/pull/143/checks)
