# P4-D3a · 固定版本的 Runbook 进入运维诊断

本批从运维任务的规则快照读取结构化 Runbook，复用既有发布证据和读取预算。 [实施计划](../plans/p4-pinned-runbook-guidance.md) · [#153](https://github.com/MaLaNg116/itervane/pull/153)

1. `87448a1` 统一从任务版本引用定位同一工作区的激活记录、人工审核、候选与通过的验证。代码规则继续使用此前的同一入口与执行画像。 [固定版本读取](https://github.com/MaLaNg116/itervane/blob/87448a1/packages/control-plane/src/service/task-published-rule-versions.ts)
2. `6070d42` 复算 Runbook 样例验证，按已退出、已停止两种状态判断唯一匹配、无匹配或歧义。模型只在读取发布证据时收到绑定版本、审批前提、次数及恢复条件。提交诊断读证据时核对原任务快照 `0080`，回看使用相同历史版本。 [判据](https://github.com/MaLaNg116/itervane/blob/6070d42/packages/control-plane/src/service/task-runbook-guidance.ts) · [证据约束](https://github.com/MaLaNg116/itervane/blob/6070d42/packages/control-plane/migrations/0080_operations_runbook_evidence.sql)
3. `6d645ee` 从已验证重启案例提炼、审核并发布 Runbook，使用后续诊断验证 Agent 的上下文和双语读回。撤回后核对旧证据及新快照。 [PostgreSQL 专项](https://github.com/MaLaNg116/itervane/blob/6d645ee/packages/control-plane/test/integration/inspections.test.ts)
4. `e9760bd` 在诊断证据中展示当前观测状态对应的固定 Runbook。浏览器用例通过键盘打开证据，验证中英文和减少动效设置。 [任务详情](https://github.com/MaLaNg116/itervane/blob/e9760bd/packages/portal/src/pages/task-operations.tsx) · [浏览器验收](https://github.com/MaLaNg116/itervane/blob/e9760bd/packages/portal/test/browser/portal.spec.ts)

TypeScript、287 项单测、Drizzle 检查和 PostgreSQL 17.12 上的 4 项回归通过。真库使用受控 Anthropic 适配器与 Whiskers 回执夹具。Chrome 场景使用真实 Keycloak、签名登录和 PostgreSQL，诊断和提议响应由浏览器用例提供。执行侧版本、审批、次数和独立恢复验收接续 D3b 和 D3c。
