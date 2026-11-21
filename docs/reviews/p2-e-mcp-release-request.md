# P2-E-B3 · 外部 MCP 正式发布申请

基于 [双语审批和候选查询 #42](https://github.com/MaLaNg116/itervane/pull/42)。 [B3 实施计划](../plans/p2-e-formal-release-approval.md#b3-工具契约)

- `get_release_options` 读取当前有权限任务的运行代次、任务版本与可申请的已登记目标，沿用门户的目标策略。外部会话收到可用目标的名称、标识及版本。 [正式目标投影](https://github.com/MaLaNg116/itervane/blob/e4c7d0d/packages/control-plane/src/mcp.ts)
- `request_release` 只接受 `taskId`、`environmentId` 和 `expectedVersion`，用 `itervane:write` 和请求者当前的项目写权限执行，与 HTTP 共用候选冻结事务。调用成功返回待审批候选。读取或重放请求使用同一候选指纹。外部客户端和门户的审批授权使用不同受众及调用边界。 [冻结服务](https://github.com/MaLaNg116/itervane/blob/e4c7d0d/packages/control-plane/src/service/formal-release.ts)
- 实际 MCP 连接验证只读 scope 拒绝写入、只读项目角色拒绝申请、撤权后隐藏任务、错项目环境、版本漂移、严格请求字段，以及新候选重放和 HTTP 一致。随后使用人用客户端确认，检查正式队列记录。 [scope 与工具发现](https://github.com/MaLaNg116/itervane/blob/e4c7d0d/packages/control-plane/test/integration/mcp.test.ts) · [实际候选用例](https://github.com/MaLaNg116/itervane/blob/e4c7d0d/packages/control-plane/test/integration/inspections.test.ts)

固定实现版本为 `e4c7d0d8a864890a45f2c6738743c652db77a4eb`。TypeScript 和真实 PostgreSQL 全量 138 项通过。集成测试源码指纹为 `6f456b635d60c3471ddd07a1027f9720aa086d6af6b5fe497dc59a9683d8733a`。E-C 将按已登记目标绑定正式队列、归档导入和下游执行。
