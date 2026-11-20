# P2-D1 · 正式审计导读

本批基于已合入的 P1-D3-C2，先固定正式审计使用的证据和规则，再接入检查点、模型及双语清单。 [实施计划](../plans/p2-d1-formal-audit.md)

## D1.1 固定输入

1. Worker 在固定源码扫描完成且覆盖完整时，以当前项目授权和租约准备输入。准备事务校验原回执、扫描策略和快照清单。输入包含任务范围、语言、用途摘要与规则目录。规则目录保留具体版本和材料，供后续审计复用。 [Worker 调用](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/src/runtime/worker.ts#L108) · [输入构建](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/src/service/formal-audit.ts#L13)
2. PostgreSQL 的记录与同一个 run 绑定。插入触发器检查当前 fence、Worker、提交、已记录的完整扫描、回执摘要和任务输入。输入一旦保存便保留，重领会重新验证原记录及摘要。 [输入契约](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/contracts/src/formal-audit.ts) · [数据库迁移](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/migrations/0012_formal_audit_inputs.sql)
3. 本地通过 TypeScript 严格检查和 14 项源码检查相关的真实 PostgreSQL 测试。新增回归核对计划态和覆盖不完整的扫描、真回执冻结、重复准备、错误快照、错误执行权以及不可修改的历史。 [集成用例](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/test/integration/inspections.test.ts#L219)

后续按计划接入审计图的检查点发布，再完成受控 ReAct、双语清单与真实模型验证。
