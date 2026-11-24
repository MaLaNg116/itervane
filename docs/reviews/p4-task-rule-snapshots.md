# P4-D1 · 正式任务固定生效规则版本

接续 [#145](https://github.com/MaLaNg116/itervane/pull/145)。迁移及锁排序固定于 `4719b130426f943d9621c9cd68cee48562e2edb5`，任务准入固定于 `01c3c2b7bf13cb26674ec45cb0b5a1a3fc767a52`。 [实施计划](../plans/p4-task-rule-snapshots.md)

1. 首次接收开发或运维诊断任务时，在同一事务保存适用规则版本集合，再唤醒 Worker。每项保留包、版本、正文摘要、审核摘要及激活序号。项目和工作区范围参与筛选，开发只选设计 Skill 与代码规则，诊断只选 Runbook。 [任务准入](https://github.com/MaLaNg116/itervane/blob/01c3c2b7bf13cb26674ec45cb0b5a1a3fc767a52/packages/control-plane/src/service/tasks.ts#L59)
2. 激活和任务快照使用同一工作区事务锁。PostgreSQL 用同一个查询复核通过审核的当前指针与完整集合，拒绝缺少、超量或替换条目。既有任务的幂等重放、重试及历史查询使用原来的集合。 [数据库选择和校验](https://github.com/MaLaNg116/itervane/blob/4719b130426f943d9621c9cd68cee48562e2edb5/packages/control-plane/migrations/0077_task_rule_snapshots.sql#L16)
3. 双语 HTTP 与 MCP 按项目授权读取任务快照。无规则的已记录集合和缺少快照的旧任务采用独立状态。 [HTTP 查询](https://github.com/MaLaNg116/itervane/blob/01c3c2b7bf13cb26674ec45cb0b5a1a3fc767a52/packages/control-plane/src/service/task-rule-snapshots.ts#L34) · [MCP 查询](https://github.com/MaLaNg116/itervane/blob/f48b637bc3a0648d947a46883b2d3611b3c02ec8/packages/control-plane/src/mcp.ts)

TypeScript、Drizzle、275 项单元和 PostgreSQL 17.12 的 6 项专项通过。覆盖跨项目匹配、工作区生效、代码规则与 Runbook 用途、并发发布、重放、回滚、撤回、直接改写拒绝及 MCP 撤权。用例采用签名 OIDC、确定性模型和受控下游回执。实际扫描第二个项目的源码、将同一 Runbook 用于后续故障，以及变更对待执行授权的影响由 P4-D2 至 D4 验收。 [真库用例](https://github.com/MaLaNg116/itervane/blob/6fe68005cc7f2c7708812178351e9778e87a665b/packages/control-plane/test/integration/rule-packages.test.ts#L291) · [托管检查](https://github.com/MaLaNg116/itervane/pull/146/checks)
