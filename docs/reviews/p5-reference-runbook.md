# P5-B6 · 参考环境 Runbook 学习与复用导读

在同一个干净参考环境中完成首次受保护实例恢复。以它的独立回执作为案例，经过提炼、样例验证和门户审核，将规则用于下一次健康事件触发的实际诊断和恢复。 [本批计划](../plans/p5-reference-runbook.md) · [前置 #166](https://github.com/MaLaNg116/itervane/pull/166)

1. `9f690f0` 从第一轮的恢复摘要保存唯一案例。同一次提交重放后读回原记录。正式提炼 Worker 使用 Anthropic 协议响应和真实 ReAct 工具，结果必须绑定当前案例。样例核对当前实例、健康、目标漂移、审批、限次与独立恢复。 [案例与验证](https://github.com/MaLaNg116/itervane/blob/9f690f0/packages/portal/test/native/reference-learning.ts)
2. `9f690f0` 用运行中的 Keycloak 门户会话创建草稿。Chrome 勾选来源、范围、实测证据后审核，再单独确认发布。第二次停止同一实例后使用既有事件调度与冷却，核对真实诊断规则快照、候选使用的验证摘要和提案中的执行约束，再完成双重审批与恢复。 [规则发布和复用](https://github.com/MaLaNg116/itervane/blob/9f690f0/packages/portal/test/native/reference-operations.ts)
3. `b91af73` 在第一套参考环境中保留新旧事件、诊断、原生审批与恢复。验收比较学习来源与实际恢复、后续规则版本和快照。另两套独立参考环境沿用开发与运维验收。 [托管验收](https://github.com/MaLaNg116/itervane/blob/b91af73/.github/workflows/native-runner.yml)

本地通过严格类型、287 项单测与 Shell 语法。真实回执和后续恢复尚待托管联验。运行身份是实际 Keycloak 门户、独立 MCP 与 Whiskers Operator，模型是脚本化 Anthropic HTTP 响应。代码规则使用匹配的真实应用修复案例另批验证。 [P4 已合入的规则复用证据](p4-native-rule-reuse.md)
