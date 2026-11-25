# P4-D4a · 固定规则与当前发布资格

本批把正式候选与任务固定规则快照绑定。当前适用规则新增、撤回或换版后，保留已有扫描和复验证据，阻止旧批准继续发送。 [实施计划](../plans/p4-current-release-rules.md) · [#156](https://github.com/MaLaNg116/itervane/pull/156)

1. `6b9d584` 在冻结、门户确认、队列领取和下游发送前用同一 workspace 规则锁核对活跃集合。新候选保存规则快照摘要，已固定代码规则时核对独立复验的规则快照。旧候选兼容读取，无规则历史仍按当前适用范围验证。 [候选与批准](https://github.com/MaLaNg116/itervane/blob/6b9d584/packages/control-plane/src/service/formal-release.ts) · [发送授权](https://github.com/MaLaNg116/itervane/blob/6b9d584/packages/control-plane/src/runtime/formal-release-claim.ts)
2. `3560a67` 迁移 `0082` 约束新候选、审批和新发送意图。既有只读对账继续根据已记录的操作和目标核对结果。 [数据库约束](https://github.com/MaLaNg116/itervane/blob/3560a67/packages/control-plane/migrations/0082_current_release_rule_authority.sql)
3. `7421aee` 在真实 PostgreSQL 验证首次发布规则影响已复验的空集合任务、撤回使候选变为证据变化、已排队发布被工人挡在发送前、旧复验可读。托管反例额外绑定实际独立重扫及候选快照。 [真库用例](https://github.com/MaLaNg116/itervane/blob/7421aee/packages/control-plane/test/integration/inspections.test.ts) · [托管验收](https://github.com/MaLaNg116/itervane/blob/7421aee/packages/control-plane/test/native/worker-inspection.ts)
4. `d29270e` 在候选证据和双语审批中显示任务规则快照摘要。 [门户](https://github.com/MaLaNg116/itervane/blob/d29270e/packages/portal/src/pages/task-release.tsx)

TypeScript、287 项单测、Drizzle、PostgreSQL 17.12 的 4 项专项和真实 Chrome 双语验收通过。真库用例的模型与 Runner 使用受控适配器及回执夹具。浏览器使用真实 Keycloak 登录，发布应答由用例提供。托管 KVM 范围见本批关联作业。运维等待审批时的主动失效与对账随后交付。
