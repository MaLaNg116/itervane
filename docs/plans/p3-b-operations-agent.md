# P3-B · 以真实证据驱动运维 Agent 的调查

接续 [只读观察门户 #73](https://github.com/MaLaNg116/itervane/pull/73) 与 [原生发布容器验收 #71](https://github.com/MaLaNg116/itervane/pull/71)。P3 的运维角色使用发布和运行证据形成假设，根据观察选择下一步，交付可核验的诊断及处置建议。 [v6 运维范围](../blueprint-v6.md) · [P3 阶段验收](../implementation-plan-v2-ts-postgresql.md)

| 批次 | 工作及退出条件 |
| --- | --- |
| B1 Whiskers 只读证据 | 继续绑定原登记的地址、服务器和完整容器 ID。增加固定尾行日志与一小时容器指标。日志文本在工具边界内转换为有限信号，指标经过字段和目标校验，只发布结构化证据。原生验收覆盖退出容器的日志、运行容器的指标、无数据、阻断与清理。 |
| B2 运维角色与循环 | 在 LangGraph Agent Harness 中按角色提供容器状态、历史发布、日志和指标。模型按需选择证据，重复、无进展及预算耗尽进入明确停止态。结果区分事实、附引用的假设与建议动作。两条对照路径验证观察改变调查步骤，覆盖虚构引用、无依据建议和异常恢复。 |
| B3 正式诊断 | 在已有只读任务上持久化事实、工具预算、检查点和结构化结论。每一步按原授权、当前租约和发布绑定复核，重复投递可恢复。门户和 MCP 读取同一双语结果。托管验收从真实发布发起诊断，使用实际 Whiskers 证据并保留可追溯回执。 |

上游 0.15.0 提供按容器调用的日志与历史指标接口。实现固定传入容器、服务器和记录窗口，选择低权限工具，并独立验证响应格式。日志信号属于应用自报线索，处置建议还需对应的运行与发布证据。 [上游容器日志](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/src/Whiskers/Mcp/Tools/ContainerTools.cs#L76) · [上游历史指标](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/src/Whiskers/Mcp/Tools/MonitoringTools.cs#L83)

P3-C 接续处置计划与本人审批、Whiskers 受控重启、Komodo 版本恢复及其独立验证。监控去重、冷却与关联修复继续沿 P3 阶段交付。
