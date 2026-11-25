# P4-D2b3 · 审计 Agent 引用已发布代码规则

从正式任务已经留存的规则检查回执接续。 [本批计划](../plans/p4-formal-audit-rules.md) · [#149](https://github.com/MaLaNg116/itervane/pull/149)

1. `41e17b3` 在当前审计回执含固定规则检查时，ReAct 循环把 Semgrep CE 加入必须读取的扫描。完成时校验每项扫描引用、发现说明和回执绑定。发送给模型的发现含不透明标识、规则键和行号。 [审计扫描投影](https://github.com/MaLaNg116/itervane/blob/41e17b3/packages/agent/src/formal-audit.ts) · [证据要求](https://github.com/MaLaNg116/itervane/blob/41e17b3/packages/agent/src/results.ts)
2. `8c695fe` 清单用原回执核对持久化发现。命中的代码规则进入人工核对，模板化修复仍从支持的发现类型建任务。双语审计页显示 Semgrep CE、命中位置及证据引用。固定规则的任务等待独立规则复验接入才能进入发布流程。 [清单发布](https://github.com/MaLaNg116/itervane/blob/8c695fe/packages/control-plane/src/service/formal-audit.ts) · [双语审计页](https://github.com/MaLaNg116/itervane/blob/8c695fe/packages/portal/src/pages/task-audit.tsx)
3. `53045b2` PostgreSQL 用例通过受控模型先尝试提前结束，再读取规则证据。验证缺少扫描时结论被拒绝、模型没有收到原路径、完整记录保存原路径和命中证据、任务进入双语人工核对状态。 [专项回归](https://github.com/MaLaNg116/itervane/blob/53045b2/packages/control-plane/test/integration/inspections.test.ts)

TypeScript、282 项单测和 5 项 PostgreSQL 17.12 专项通过。专项采用标记为 Anthropic 的受控模型适配器及 Runner 回执夹具。真实 Semgrep 和 KVM 扫描回执已经在前置批次固定。独立规则复验和第二个登记项目的真实规则复用属于后续验收。 [原生规则扫描证据](p4-qualified-published-inspection.md)
