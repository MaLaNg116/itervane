# P4-D3b · 固定 Runbook 约束受控重启

本批重启提议保存已引证的 Runbook、任务规则快照摘要、观测状态和匹配判据。后续选择沿用这个版本及现有的门户与 Whiskers 审批。 [实施计划](../plans/p4-runbook-restart-authority.md) · [#154](https://github.com/MaLaNg116/itervane/pull/154)

1. `2628221` 让 Agent 为匹配 Runbook 的重启建议引用发布证据。从真实诊断选定唯一版本，在呈批、确认和执行权核对时重新比较当前适用规则快照。撤回或更新后原诊断仍可查看，原动作需要重新诊断和确认。 [证据引用](https://github.com/MaLaNg116/itervane/blob/2628221/packages/agent/src/operations-results.ts) · [呈批绑定](https://github.com/MaLaNg116/itervane/blob/2628221/packages/control-plane/src/service/operations-proposals.ts)
2. `260e813` 独立检查停止状态、拟发送或已发送的次数和原生审批的续办绑定。明确仍待审批的回执保留原有的有限重试。已发送或结果不确定时走只读核对，确定的健康失败在第一次独立检查后交给人工。迁移 `0081` 约束证据引用、冻结状态、次数和健康结算。 [发送闸门](https://github.com/MaLaNg116/itervane/blob/260e813/packages/control-plane/src/runtime/operations-execution-lease.ts) · [恢复判据](https://github.com/MaLaNg116/itervane/blob/260e813/packages/control-plane/src/runtime/operations-restart-recovery.ts) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/260e813/packages/control-plane/migrations/0081_runbook_restart_authority.sql)
3. `3a1a99b` 以真实 PostgreSQL 走固定 Runbook 的后续任务，覆盖缺少引用的模型申请、目标状态漂移、重复续办、健康验证通过与失败、撤回后重新授权。无匹配的旧任务继续经过原有流程。 [专项用例](https://github.com/MaLaNg116/itervane/blob/3a1a99b/packages/control-plane/test/integration/inspections.test.ts)
4. `1ae92dc` 在审批前显示固定版本与次数，保留现有角色和操作入口。 [双语审批](https://github.com/MaLaNg116/itervane/blob/1ae92dc/packages/portal/src/pages/task-operations-proposal.tsx)

TypeScript、287 项单测、Drizzle 检查、PostgreSQL 17.12 的 5 项回归和真实 Chrome 双语验收通过。真库用例使用受控 Anthropic 适配器和 Whiskers、恢复回执夹具。浏览器使用真实 Keycloak，诊断与审批响应由场景提供。后续托管验收引用真实 Whiskers 效果和独立 Komodo 读回。已撤回批次的通用队列清理与权限失效接续 D4。
