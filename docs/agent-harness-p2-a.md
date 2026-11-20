# P2-A 内置 Agent 运行与验证

P2-A 交付可独立运行的交付 Agent。一个 LangGraph 实例串行调度审计、修复和复验。模型按当前观察选工具，平台核对角色、参数、作用范围和预算，结果来自与当前快照绑定的回执。工作范围和 P1 依赖见 [P2-A 实施计划](plans/p2-a-agent-harness.md)。

## 在本机跑通样例

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm probe:agent
pnpm check
pnpm test:integration
```

`pnpm probe:agent` 默认使用确定性模型驱动和内存 checkpointer。它处理仓库生成的显示配置和分页配置样例，分别使用 `zh-CN`、`en`。同一个 Agent 根据 `overview` 的观察分支、选模板、取得三类检查回执，再交付复验结果。报告写入 `.reports/p2-a/deterministic.json`，记录源码指纹、工具分支、候选摘要、用量、三类检查结果及执行资格。

真实 PostgreSQL 17 的恢复由集成测试覆盖。默认启动一次性测试数据库，也可用隔离的专用测试库。P2-A 单独创建测试 schema，用不同的 checkpointer 连接检查调用预留和恢复。门户、MCP、Worker 及执行闸门的回归沿用原有测试。

## 本地模型协议联调

```sh
pnpm probe:agent --live
```

使用已忽略提交的 `.env` 或进程环境。选择 `MODEL_PROVIDER=anthropic` 时读取 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL`、`ANTHROPIC_BASE_URL`。OpenAI 协议使用 `MODEL_PROVIDER=openai` 和对应的 `OPENAI_*` 变量。该命令要求显式配置本机回环地址，通过禁止重定向的 HTTP 客户端仅发送固定合成样例。报告为 `.reports/p2-a/live_loopback.json`。两个驱动分别留证，真实模型的行为复跑可能变化。

内置 Agent 请求单工具轮次，Anthropic 和 OpenAI 适配器使用各自的串行选项。Harness 仍会检查返回的调用数量。兼容服务出现批量返回时，整轮进入反馈流程，达到无进展上限就转人工。参阅 [Anthropic 工具调用约定](https://platform.claude.com/docs/en/agents-and-tools/tool-use/parallel-tool-use) 和 [OpenAI 函数调用约定](https://developers.openai.com/api/docs/guides/function-calling#parallel-function-calling)。

## 回执、预算与恢复

- 模型可以读取源快照片段、版本化内置指导及受保护检查，也可以选择登记模板或请求人工。每轮从该角色已接纳的证据重建有限上下文，并送回该角色最近一次的原生工具结果引用。已取得的相同观察会在执行前去重。检查点仅持久化经契约接纳的工具决策、证据、角色产物及运行状态。
- 复验对同一候选读取重复扫描、平台基线及针对性检查的结果。机器用受保护回执判定原发现、新增问题和未完成项。样例复验的是生成的 JSON 候选。校验覆盖设置值、状态标签基线及指定设置的修复条件。
- 轮次和工具调用在执行前预留，模型输出 token 上限在请求中给出，总 token 用量按模型回报累计。上下文限额度量系统提示和组装后的消息。最终计费取决于模型服务。
- 已确认边界中的下一步决定可恢复，预算和截止时间继续有效。只有预留而没有结果的动作转入人工核对。当前驱动使用独立检查点线程，同一 Harness 实例拒绝并发执行同一个 run。正式多进程执行须使用 P1 的租约、fence 和已发布指针。

## 正式执行资格

全部报告带 `origin: trusted_fixture` 和 `releaseEligible: false`。平台能力继续处于 P1-E，正式任务从门户或外部 MCP 进入既有 Worker，并在源码检查步骤等待合格 Runner。D2/D3 要给出一次性 VM、固定源码取得和实际任务检查的绑定证据。后续 P2 还需验证干净环境复验、候选冻结、人工批准、Komodo 发布及实际运行版本。运维 MCP 与规则/Skill 生命周期分别在 P3 和 P4 交付。参阅 [开发与运行闸门](decisions/0001-development-and-runtime-gates.md) 和 [正式检查点发布](decisions/0002-checkpoint-publication.md)。
