# P4-B2a · ReAct 规则提炼 Agent

接续 [PR #137](https://github.com/MaLaNg116/itervane/pull/137)。候选格式固定于 `f005cdd2be53828769ab7db2c11fbc2701840a85`，Agent 实现固定于 `b8cee4618ea0acf964048e9b77da4271ea29c448`。 [实施计划](../plans/p4-rule-extraction-agent.md)

1. 第五种逻辑角色进入已有 LangGraph ReAct 图。它自主决定先读已核验案例还是同类索引，两项观察后才有结束入口。模型使用固定的工具目录、执行预算和中文或英文提示。案例、项目、模型及索引摘要共同绑定检查点。 [启动入口](https://github.com/MaLaNg116/itervane/blob/b8cee4618ea0acf964048e9b77da4271ea29c448/packages/agent/src/formal-rule-extraction.ts#L22)
2. 结果可为待验候选、证据不足只保留案例，或引用已有候选。完成器核对两项实际观察、来源类别、重复匹配参数和 Runbook 范围。代码检查采用定界 Semgrep 声明和三类样例，Runbook 采用固定重启类型、双重确认及独立核对。 [候选契约](https://github.com/MaLaNg116/itervane/blob/f005cdd2be53828769ab7db2c11fbc2701840a85/packages/contracts/src/rule-extraction.ts) · [完成器](https://github.com/MaLaNg116/itervane/blob/b8cee4618ea0acf964048e9b77da4271ea29c448/packages/agent/src/rule-extraction-result.ts#L12)
3. 恢复时重新验证检查点中的工具结果和候选决定。撤权停止向模型或调用方提供该次证据。运行结果是待验材料，发布与实际执行走独立工序。 [状态恢复](https://github.com/MaLaNg116/itervane/blob/b8cee4618ea0acf964048e9b77da4271ea29c448/packages/agent/src/state.ts)

本地 TypeScript 与 262 项单元通过，包含 9 项提炼用例。用例覆盖两种读取顺序、中英文、保留、重复、伪造证据、非法动作、停顿预算、检查点接管和撤权。使用确定性模型与内存检查点，B2b 接入 PostgreSQL、正式单槽调度及原生案例运行。 [专项用例](https://github.com/MaLaNg116/itervane/blob/d4bb3620a18c2b33ba0fe71248306d155f60d804/packages/verification/test/unit/formal-rule-extraction-agent.test.ts#L70) · [托管检查](https://github.com/MaLaNg116/itervane/pull/138/checks)
