# P2-E-C4-B · 正式 Komodo 派发与恢复导读

基于版本化目标和受限适配器的 [PR #50](https://github.com/MaLaNg116/itervane/pull/50)。 [分批计划](../plans/p2-e-formal-komodo-ledger.md)

## C4-B1 的 Registry 前置条件

`5678ce5ba49ba01a3f23c2316132e9b9671b2e87` 中的 `FormalReleaseSteps.readRegistryProof` 同时核对当前阶段与已确认证据。步骤表保留旧证据，供审计和比对。曾完成核验的进程失去租约后，接续者先进入待核对并回读；新租约完成核对后，该方法再返回证明。

此版本 TypeScript 和 178 项单元通过。真实 PostgreSQL 专项核对了原租约失效、历史证明在待核对期间不可使用、同操作通过新租约确认相同制品，以及只读恢复者没有 Registry 写入权。下一批把这些前置条件接到两条独立的 Komodo 步骤和真实 Worker 验收。
