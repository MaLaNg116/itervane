# P2-D1 · 正式审计导读

本批基于已合入的 P1-D3-C2，先固定正式审计使用的证据和规则，再接入检查点、模型及双语清单。 [实施计划](../plans/p2-d1-formal-audit.md)

## D1.1 固定输入

1. Worker 在固定源码扫描完成且覆盖完整时，以当前项目授权和租约准备输入。准备事务校验原回执、扫描策略和快照清单。输入包含任务范围、语言、用途摘要与规则目录。规则目录保留具体版本和材料，供后续审计复用。 [Worker 调用](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/src/runtime/worker.ts#L108) · [输入构建](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/src/service/formal-audit.ts#L13)
2. PostgreSQL 的记录与同一个 run 绑定。插入触发器检查当前 fence、Worker、提交、已记录的完整扫描、回执摘要和任务输入。输入一旦保存便保留，重领会重新验证原记录及摘要。 [输入契约](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/contracts/src/formal-audit.ts) · [数据库迁移](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/migrations/0012_formal_audit_inputs.sql)
3. 本地通过 TypeScript 严格检查和 92 项真实 PostgreSQL 测试，其中 14 项覆盖源码检查与审计交接。测试端口提供固定的结构化回执，数据库回归核对计划态、覆盖不完整、重复准备、错误快照、错误执行权及不可修改的历史。 [集成用例](https://github.com/MaLaNg116/itervane/blob/b4456bb614f1bfbb0e0a6d9cbbf7fb16a356602c/packages/control-plane/test/integration/inspections.test.ts#L219) · [本批原生复跑](https://github.com/MaLaNg116/itervane/actions/runs/44776411861)

## D1.2 检查点发布

1. 审计与前置检查各有固定的 LangGraph thread 和领域发布指针。审计读取、发布和保存中间写入时检查当前租约、项目授权和已保存的输入摘要。现有中间写入迁移后标记为 `preflight`。 [发布包装](https://github.com/MaLaNg116/itervane/blob/2863b37fa88e193cf1646356c44e82bb92989619/packages/control-plane/src/runtime/checkpointer.ts) · [迁移](https://github.com/MaLaNg116/itervane/blob/2863b37fa88e193cf1646356c44e82bb92989619/packages/control-plane/migrations/0013_formal_audit_checkpoints.sql)
2. 真实 PostgreSQL 上让两张图使用相同的底层 checkpoint ID，确认前置写入回执无法被审计复用。再让底层 saver 保存成功、领域指针提交失败，确认重领后仍从已发布指针恢复。专项 15 项通过，覆盖输入摘要变化与过期 Worker 写入。 [集成验收](https://github.com/MaLaNg116/itervane/blob/2863b37fa88e193cf1646356c44e82bb92989619/packages/control-plane/test/integration/inspections.test.ts)

## D1.3 ReAct 审计循环与工具

1. `createFormalAudit` 核对固定输入和扫描回执的摘要、任务与快照，按严重度和发现 ID 为每种扫描整理最多八条发现。模型上下文只含固定的审计目标、归一化发现和查询到的规则指导。精确路径保持在原始回执中，供按权限查询与后续修复使用。Gitleaks 模式命中标为疑似，Trivy 命中表示依赖与固定公告库匹配。 [证据投影与审计入口](https://github.com/MaLaNg116/itervane/blob/799c95ae8f6acf6290f087d0915b1cba568e9bc6/packages/agent/src/formal-audit.ts#L17)
2. 正式审计复用 P2-A 的保存预算、模型决策和工具观察三个节点。`read_scan` 可分别读取两种扫描，`read_rule` 限定为任务固定目录中的规则。模型可以依据观察选择查阅指导或继续下一项扫描。恢复绑定输入及模型配置的摘要，沿用独立的 `audit:<runId>` 检查点。 [循环与恢复](https://github.com/MaLaNg116/itervane/blob/799c95ae8f6acf6290f087d0915b1cba568e9bc6/packages/agent/src/harness.ts#L155) · [工具范围](https://github.com/MaLaNg116/itervane/blob/799c95ae8f6acf6290f087d0915b1cba568e9bc6/packages/agent/src/tools.ts)
3. 结束审计需要引用两种扫描，并为每条所列发现提供影响和防护建议。服务器取得严重度、确定性和覆盖范围。发现超过投影上限或存在待确认的假设时，阶段结果转人工。后续发布资格继续依据独立复验和人工确认。 [清单核对](https://github.com/MaLaNg116/itervane/blob/799c95ae8f6acf6290f087d0915b1cba568e9bc6/packages/agent/src/results.ts#L43)
4. 11 项新增用例使用确定性的模型响应和内存检查点，覆盖不同观察引出的调查路径、摘要变化、虚构引用、截断、停止条件和在途调用恢复。`pnpm check` 通过 118 项单元测试，1 项 Linux 专用测试跳过。另通过 93 项真实 PostgreSQL 回归，其中 15 项覆盖源码检查和审计交接。 [专项验收](https://github.com/MaLaNg116/itervane/blob/799c95ae8f6acf6290f087d0915b1cba568e9bc6/packages/verification/test/unit/formal-audit.test.ts) · [D1.2 原生回归](https://github.com/MaLaNg116/itervane/actions/runs/44777551578)

后续接入正式 Worker 的租约校验与模型配置，登记审计清单并提供双语门户与 MCP 查询。真实模型验收仍按本批计划执行。
