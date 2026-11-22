# P3-C2c2a · Whiskers 重启续发与接管导读

本批接续 #92 的原生批准回执和暂停，固定代码版本为 `9831705ab3c9fb290950e00c905eb46abc0be989`。 [草稿 #93](https://github.com/MaLaNg116/itervane/pull/93) · [阶段计划](../plans/p3-c-whiskers-restart-execution.md)

1. `af1901c` 的迁移 0052 将续发记录绑定到原生批准 ID、调用指纹、原平台批准者及其授权代次。数据库约束限定请求顺序、次数、状态和发送租约，提交时复核任务、队列和执行槽是否同步。 [续发约束](https://github.com/MaLaNg116/itervane/blob/9831705ab3c9fb290950e00c905eb46abc0be989/packages/control-plane/migrations/0052_operations_restart_resumes.sql#L32)
2. `57e0426` 以同一已认证的门户批准者接收任务版本和幂等键，事务内完成授权复核、双语事件及入队。Worker 领取后复核批准、权限、目标和原 Write 凭证指纹，随后持租约写入本次发送意图。 [续发请求](https://github.com/MaLaNg116/itervane/blob/9831705ab3c9fb290950e00c905eb46abc0be989/packages/control-plane/src/runtime/operations-execution-lease.ts#L212) · [发送意图](https://github.com/MaLaNg116/itervane/blob/9831705ab3c9fb290950e00c905eb46abc0be989/packages/control-plane/src/runtime/operations-execution-lease.ts#L256)
3. 发送意图落库前，接管者可重新领取同一请求。意图落库后，租约丢失、收到执行回执或结果不明时转入只读核对。同一批准 ID 仍明确待批时可等待下一次人工续发，最多三次。等待继续保留同环境占用，释放全局执行槽。平台撤销会阻断续发，保留原处置记录供核对。 [接管逻辑](https://github.com/MaLaNg116/itervane/blob/9831705ab3c9fb290950e00c905eb46abc0be989/packages/control-plane/src/runtime/operations-execution-lease.ts#L68) · [结果转换](https://github.com/MaLaNg116/itervane/blob/9831705ab3c9fb290950e00c905eb46abc0be989/packages/control-plane/src/runtime/operations-execution-lease.ts#L291)
4. `9831705` 验证重复提交、门户身份、调用及凭证绑定、同一批准的三次上限、撤销后只读接管，以及租约过期后阻止旧 Worker 提交。 [真库用例](https://github.com/MaLaNg116/itervane/blob/9831705ab3c9fb290950e00c905eb46abc0be989/packages/control-plane/test/integration/inspections.test.ts#L3009)

本机通过 TypeScript、229 项单元、11 项真实 PostgreSQL 17.12 专项和 Drizzle 迁移一致性检查。C2c2b 接续真实 Whiskers Write 策略、人工原生批准与单次派发验证，C2c3 完成独立健康核对及结算。 [托管检查](https://github.com/MaLaNg116/itervane/pull/93/checks)

2026-11-22 合入复核固定在 `73c2d4e7851e6115941d0e1b77c26ee9409a41ae`。核对了人工续发身份和原批准绑定、发送次数、撤销，以及发送后仅由新代次核对的边界。17 项托管检查全部通过，含九组 KVM、原生 Whiskers、密封输入和常规回归。 [托管检查](https://github.com/MaLaNg116/itervane/pull/93/checks) · [KVM 联验](https://github.com/MaLaNg116/itervane/actions/runs/45019144949) · [主线合并提交](https://github.com/MaLaNg116/itervane/commit/98f9d818fd370db3f22da8d8adb05603ce4dec0e)
