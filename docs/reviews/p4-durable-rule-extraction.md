# P4-B2b · 正式规则提炼调度与候选记录

接续 [PR #138](https://github.com/MaLaNg116/itervane/pull/138)。接口固定于 `9992b65eae8706a26596061b6faaca09f41e68cb`，执行固定于 `7b3f50232d68f5c9704d251a60f646dd7e520a6c`。 [实施计划](../plans/p4-durable-rule-extraction.md)

1. `POST /v1/projects/:projectId/learning-cases/:caseId/extractions` 在同一事务固定案例、模型和当前授权，并接收任务和队列唤醒。API 使用 `ITERVANE_RULE_EXTRACTION_PROVIDER_SHA256`，Worker 沿用已配置的模型。指纹使用协议、规范化地址和模型标识，不包含 Key。 [准入事务](https://github.com/MaLaNg116/itervane/blob/9992b65eae8706a26596061b6faaca09f41e68cb/packages/control-plane/src/service/rule-extraction.ts#L52)
2. 首次执行时在全局单槽冻结同项目的已核验案例和候选索引，使用提炼专用 PostgreSQL 检查点。失去授权、配置漂移或失去租约时，过期执行者不能写入候选。结算复核两项证据、检查点和当前任务，再保存不可变结果和对应任务事件。 [执行逻辑](https://github.com/MaLaNg116/itervane/blob/7b3f50232d68f5c9704d251a60f646dd7e520a6c/packages/control-plane/src/runtime/formal-rule-extraction.ts#L86) · [数据库结算闸门](https://github.com/MaLaNg116/itervane/blob/ac5665a10ec6395c814c9cc7125890733c6bc7fd/packages/control-plane/migrations/0074_durable_rule_extraction.sql#L169)
3. `GET /v1/tasks/:taskId/rule-extraction` 提供中文和英文状态，返回代码规则候选、Runbook 候选或保留与重复决定。原生测试使用同一正式健康修复和同一确认重启的实际案例，通过 HTTP、正式 Worker 与实际 Anthropic 协议适配器记录候选。代码样例执行和 Runbook 复用由独立批次验收。 [原生场景](https://github.com/MaLaNg116/itervane/blob/1887414231255b83f2ad6fc18bea015e8d922c91/packages/control-plane/test/native/worker-inspection.ts#L1006)

本地 TypeScript、Drizzle、Bash、262 项单元及 PostgreSQL 17.12 的 5 项专项通过。真库额外覆盖并发重放、检查点写入、模型指纹不符、租约接管、项目角色撤回及旧候选去重。使用签名 OIDC、确定性模型和既有 Runner 回执夹具。托管检查验收实际 VM、受保护运行及来源回执，模型响应范围为确定性的 Anthropic 协议夹具。 [真库用例](https://github.com/MaLaNg116/itervane/blob/a92c6ef87976e4753d0227c4f9999661a403372b/packages/control-plane/test/integration/inspections.test.ts#L5887) · [托管检查](https://github.com/MaLaNg116/itervane/pull/139/checks)

提交 `03f13283bd7dbeafdc22e2ed5709abbcd4ec6418` 已通过托管的两条正式来源场景。下载工件核对了每项候选与真实案例及独立恢复证据的绑定。健康复现与修复分别返回 503 和 200，产出代码规则。受控重启恢复同一实例，返回 200，产出 Runbook。两场景均以确定性 Anthropic 协议模型完成两项观察后提交候选。 [代码规则回执](https://github.com/MaLaNg116/itervane/actions/runs/45375987309/artifacts/14913630983) · [Runbook 回执](https://github.com/MaLaNg116/itervane/actions/runs/45375987309/artifacts/14911927823)
