# 009 · P2-A 内置 Agent 与三角色循环导读

- 基线为已合并 #1–#8 的 `main`，版本 `f10a4e2c7780b151a48b5c7b9a8331b446b230f8`。
- 固定代码为 `08d6cfc1088efdd465f4828cf74df57052605d4b`。计划先于代码提交。参阅 [本批计划](../plans/p2-a-agent-harness.md)、[运行说明](../agent-harness-p2-a.md)和 [v6 §4–10](../blueprint-v6.md#4-agent-架构采用外层治理工作流与内层自主循环)。

## 1. 从运行入口看交付边界

先读 `probe:agent`。入口创建两组仓库维护的固定设置样例，分别使用简体中文与英文。样例生成任务范围、合成 source ref、数据摘要、版本化规则目录摘要和检查基线摘要。Harness 只依赖模型端口、可信回执端口和 checkpointer。本批报表的 origin 固定为 `trusted_fixture`，发布资格固定为 `false`。 [样例入口](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/verification/src/entries/agent.ts#L27)、[样例和 host](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/verification/src/agent/fixture.ts#L101)、[回执契约](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/contracts.ts#L61)

对照现有 Worker 的 `source.inspect` 与 API capability。两者展示正式隔离仍是运行依赖。P1 的任务授权、租约、执行代次和领域检查点发布协议继续作为正式接入约束。D2 负责一次性 VM 的生命周期与隔离证据，D3 负责固定 commit 取得、扫描回执与真实任务绑定。候选审批、Komodo 发布、Whiskers 运维 MCP 和规则/Skill 沉淀的验收各自保留。 [Worker 闸门](https://github.com/MaLaNg116/itervane/blob/f10a4e2c7780b151a48b5c7b9a8331b446b230f8/packages/control-plane/src/runtime/worker.ts#L70)、[API 能力](https://github.com/MaLaNg116/itervane/blob/f10a4e2c7780b151a48b5c7b9a8331b446b230f8/packages/control-plane/src/api.ts#L90)、[隔离计划](../plans/p1-d-isolated-source-inspection.md)、[检查点发布](../decisions/0002-checkpoint-publication.md)

## 2. 跟一轮 ReAct

1. `reserve` 核对当前授权和预算，写入本轮动作类型与已用次数。`durability: sync` 让下一节点在该预留写入后才开始。同步边界由真实 PostgreSQL 上的第二个连接读到。 [预留节点](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/harness.ts#L184)、[持久化配置](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/harness.ts#L270)、[PG 时序验证](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/verification/test/integration/agent-checkpoints.test.ts#L38)
2. `decision` 按角色组装有界的事实索引和最新观察。最近的一条接纳回执会通过原生工具结果引用关联到调用，角色交接会重置本角色上下文。模型选择工具或结束。适配器向两种协议发送单工具选项，Harness 对批量、重复或无效的动作给反馈，达到无进展上限后转人工。 [上下文](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/harness.ts#L53)、[决策节点](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/harness.ts#L196)、[模型传输](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/model/src/adapters.ts#L39)
3. `observation` 在调用前与回执后复核当前授权、取消和时间。工具由服务端匹配角色与当前候选，返回数据通过严格 schema、快照和 binding 摘要校验后加入证据。恢复仍按同一任务输入和限额校验。 [取证节点](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/harness.ts#L230)、[回执门槛](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/tools.ts#L72)、[恢复校验](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/state.ts#L44)

审计读取的显示或分页区段来自 overview 的观察。确定性测试驱动响应观察和缺少的检查，覆盖内层动态选择。外层角色顺序固定，复验失败可按预算回到修复。 [观察驱动](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/verification/src/agent/scripted-model.ts#L11)、[角色交接](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/harness.ts#L107)

## 3. 跟一个候选和复验结论

审计说明逐项绑定受保护发现，并保留覆盖限制。修复只选择登记模板，生成 JSON 候选字节与可读 unified diff，带原快照、候选及差异 SHA-256。复验从原始样例与模板重建候选，逐一校验回执；最终由机器比较重复扫描、状态标签基线与针对性检查。测试中的宽模板会修改无关标签并被拦住，另一个候选重新复验才完成。 [角色输出](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/results.ts#L13)、[模板与检查](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/verification/src/agent/fixture.ts#L52)、[回归和返修](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/verification/test/unit/agent-delivery.test.ts#L56)

## 4. 验收与待验证事项

| 验收 | 证据 |
| --- | --- |
| 静态检查与单元测试 | `pnpm check` 通过 92 项单元测试。覆盖双协议 SDK 的本机协议夹具、错误引用、目标不符、预算、授权、取消、上下文收缩和重复动作。 |
| 真实 PostgreSQL 17 | `pnpm test:integration` 通过 69 项。新增 3 项覆盖动作前可读预留、已确认边界重新连接、未确认预留不重复、输入变化及撤权。原 Worker、外部 MCP 和 API 继续运行各自的资格回归。 |
| 样例完整闭环 | `pnpm probe:agent` 完成中文显示与英文分页两条路径，各 13 轮、10 次工具调用，每个候选的 3 项检查均通过。记录见本机 `.reports/p2-a/deterministic.json`。 |
| 门户 | 本地 `pnpm test:portal` 完成 21 项浏览器用例，覆盖 OIDC、项目角色、两种语言、任务与预审。 |
| 真实模型 | 本机 Anthropic 兼容端点已返回真实工具调用及计量。最终两组试跑在审计阶段因 `provider_error` 进入人工；诊断复跑观测到 HTTP 503。两条完整路径的真实模型验收仍待通过。 |

2026-11-22 在 P2 发布故障验收的同源码指纹 `5a2f9fec1d0c984d91637645c9ca8b37c3f7780b7548fba2fbf7f04cf9f7c6f7` 复跑 `pnpm probe:agent --live`，两种语言都在审计阶段读取一次工具后以 `provider_error` 转人工。单独诊断确认本机 Anthropic 兼容端点接受首个请求，收到首个工具结果后返回 HTTP 503。该报告仅覆盖本机可信样例。托管 KVM 的发布流程继续使用脚本模型，真实模型对实际复验回执的证据另有记录。 [发布故障验收](p2-e-protected-release-faults.md) · [复验模型证据](p2-d3-d-verification-agent.md)
| 正式执行 | D2/D3、正式调度接入、一次性 VM 中复验和完整 P2 发布闭环待验。未来的多进程恢复与并发由领域租约和正式检查点所有权约束。 |

最终代码的确定性复跑源码指纹为 `49876ec9aafa43fa882902d0e153ce81ac27f16eaa998c2e0eed6d62a20f8765`。本机 Anthropic 试跑在超时判定修复前完成，记录的源码指纹为 `f44f8a4e289c1e9304e2bc2ca1780f2be5e98bec1812891a1abdbc9227a36601`。

首次 Linux 分支检查发现一个超时判定竞态。定时器已中止调用时，墙上时钟可能还差一毫秒。现在以中止信号和墙上截止时间共同判定，并用固定墙上时钟的测试复现。 [首次 CI 记录](https://github.com/MaLaNg116/itervane/actions/runs/44686824266/job/136123026269)、[超时回归](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/verification/test/unit/agent-delivery.test.ts#L209)

优先核对三处代码。第一，检查调用是否总在预留后执行。第二，检查复验接纳的是同一候选的三种机器回执。第三，检查样例结果进入正式 Worker/API 前必须具备的 Runner 与领域授权。 [三个 PG 用例](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/verification/test/integration/agent-checkpoints.test.ts#L38)、[独立复验判定](https://github.com/MaLaNg116/itervane/blob/08d6cfc1088efdd465f4828cf74df57052605d4b/packages/agent/src/results.ts#L46)、[正式运行边界](../agent-harness-p2-a.md#正式执行资格)
