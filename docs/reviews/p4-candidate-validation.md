# P4-C1 · 代码规则样例与 Runbook 判据

接续 [PR #139](https://github.com/MaLaNg116/itervane/pull/139)。合同固定于 `7702c5f038946fe47a55cbb6be8d477d018f66eb`，验证逻辑固定于 `472ce131696a358be5f1810ea36aceb8261bd2d3`。 [实施计划](../plans/p4-candidate-validation.md)

1. 代码候选编译为一个 Semgrep CE 本地配置。固定顺序的违规、修正和易误判样例分别计算摘要。输入包含候选回执、配置、检查器及 Runner 映像的绑定，便于隔离执行器重建。 [配置和样例](https://github.com/MaLaNg116/itervane/blob/472ce131696a358be5f1810ea36aceb8261bd2d3/packages/rules/src/code-rule-validation.ts#L14)
2. 每份扫描结果先核对版本、扫描覆盖、规则编号和该样例路径。保留报告摘要与计数，拒绝不完整或替换结果。违规、修正和易误判分别为 1、0、0 时通过。 [扫描归一化](https://github.com/MaLaNg116/itervane/blob/472ce131696a358be5f1810ea36aceb8261bd2d3/packages/rules/src/code-rule-validation.ts#L36)
3. Runbook 判据覆盖当前发布、实例状态、审批、次数，以及原生应答、同实例、更新的启动时间、健康结果和访问保护。样例评估给出确定性处置结论，正式派发继续沿用已有审批与独立核对。 [Runbook 判据](https://github.com/MaLaNg116/itervane/blob/472ce131696a358be5f1810ea36aceb8261bd2d3/packages/rules/src/runbook-validation.ts#L6)

本地 TypeScript 与 272 项单元通过，其中 10 项新增用例验证匹配、漏检、误报、输入替换、无覆盖、错误版本和 Runbook 正反状态。扫描结果采用固定响应，托管 Semgrep CE 与一次性 VM 执行由 C2 验收。 [专项用例](https://github.com/MaLaNg116/itervane/blob/2a87d77cb8bde3f022721c1209c6882827c8fa8b/packages/rules/test/unit/candidate-validation.test.ts) · [托管检查](https://github.com/MaLaNg116/itervane/pull/140/checks)
