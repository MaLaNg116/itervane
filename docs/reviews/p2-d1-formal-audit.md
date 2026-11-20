# P2-D1 · 正式审计导读

本批基于已合入的 P1-D3-C2，先固定正式审计使用的证据和规则，再接入检查点、模型及双语清单。 [实施计划](../plans/p2-d1-formal-audit.md)

## D1.1 固定输入

1. Worker 在固定源码扫描完成且覆盖完整时，以当前项目授权和租约准备输入。准备事务校验原回执、扫描策略和快照清单。输入包含任务范围、语言、用途摘要与规则目录。规则目录保留具体版本和材料，供后续审计复用。 [Worker 调用](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/src/runtime/worker.ts#L108) · [输入构建](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/src/service/formal-audit.ts#L13)
2. PostgreSQL 的记录与同一个 run 绑定。插入触发器检查当前 fence、Worker、提交、已记录的完整扫描、回执摘要和任务输入。输入一旦保存便保留，重领会重新验证原记录及摘要。 [输入契约](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/contracts/src/formal-audit.ts) · [数据库迁移](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/migrations/0012_formal_audit_inputs.sql)
3. 本地通过 TypeScript 严格检查和 92 项真实 PostgreSQL 测试，其中 14 项覆盖源码检查与审计交接。测试端口提供固定的结构化回执，数据库回归核对计划态、覆盖不完整、重复准备、错误快照、错误执行权及不可修改的历史。 [集成用例](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/test/integration/inspections.test.ts#L219) · [本批原生复跑](https://github.com/MaLaNg116/itervane/actions/runs/44776411861)

## D1.2 检查点发布

1. 审计与前置检查各有固定的 LangGraph thread 和领域发布指针。审计读取、发布和保存中间写入时检查当前租约、项目授权和已保存的输入摘要。现有中间写入迁移后标记为 `preflight`。 [发布包装](https://github.com/MaLaNg116/itervane/blob/2863b37fa88e193cf1646356c44e82bb92989619/packages/control-plane/src/runtime/checkpointer.ts) · [迁移](https://github.com/MaLaNg116/itervane/blob/2863b37fa88e193cf1646356c44e82bb92989619/packages/control-plane/migrations/0013_formal_audit_checkpoints.sql)
2. 真实 PostgreSQL 上让两张图使用相同的底层 checkpoint ID，确认前置写入回执无法被审计复用。再让底层 saver 保存成功、领域指针提交失败，确认重领后仍从已发布指针恢复。专项 15 项通过，覆盖输入摘要变化与过期 Worker 写入。 [集成验收](https://github.com/MaLaNg116/itervane/blob/2863b37fa88e193cf1646356c44e82bb92989619/packages/control-plane/test/integration/inspections.test.ts)

后续接入受控的 ReAct 审计执行、双语清单与真实模型验证。
