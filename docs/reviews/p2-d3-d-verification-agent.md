# P2-D3-D-B · 正式复验 Agent Review Guide

本批依赖 [复验事实 #33](https://github.com/MaLaNg116/itervane/pull/33)。首次原生试验代码为 `efb21ac85f9c182884abc56f413c6f2488a72291`。 [实施计划](../plans/p2-d3-d-verification-agent.md)

1. `0aefef5` 将正式复验接入现有 LangGraph。角色只能读取当前回执的有限事实，HTTP 基线决定是否提供镜像观察。完成时算法重新推导比较与覆盖结果，模型说明和建议须引用本轮实际观察。恢复入口再次核对每项观察的固定摘要。 [角色入口](../../packages/agent/src/formal-verification.ts) · [执行循环](../../packages/agent/src/harness.ts) · [完成判定](../../packages/agent/src/results.ts)
2. `f6df2ac` 验证英文健康路径增加镜像观察，中文 503 路径保留失败与建议。非法申请、提前索取镜像、伪造引用均无法取得复验结论。 [模型对照](../../packages/verification/test/unit/formal-verification-agent.test.ts)
3. `c91c803` 正式入口复用已记录的 Runner 回执，在当前执行租约下发布 `verify:<runId>` 检查点。输入、回执、Worker、fence 和代次均有数据库约束。已保留的一次只读观察可由新 Worker 续作，原执行者和撤权后的调用无法读取进度。 [正式入口](../../packages/control-plane/src/runtime/formal-verification.ts) · [检查点约束](../../packages/control-plane/migrations/0025_formal_verification_checkpoint.sql)
4. `efb21ac` 用托管 Runner 的真实候选和 503 回归试验正式入口，保存独立模型试验所需的冻结输入及有界事实。持久化角色试验使用脚本适配器，另可用 `pnpm probe:formal-verify --live <runner-worker-build.json>` 在本机已授权的回环模型上复跑。 [原生试验](../../packages/control-plane/test/native/worker-verification.ts) · [真实模型入口](../../packages/verification/src/entries/formal-verification.ts)

本机 Linux 的 TypeScript 检查、157 项单元测试和 121 项真实 PostgreSQL 集成通过。恢复对照确认新 Worker 延续已预留的观察，模型共运行五轮，Runner 只派发一次。首次远端数据库检查发现历史修复夹具清理遗漏复验检查点表，`b0f5704` 补齐夹具清理后已复跑完整数据库套件。 [首次远端检查](https://github.com/MaLaNg116/itervane/actions/runs/44901293414/job/136837551418)

托管 Runner 的 OCI 试验固定在 `95403440ff6cd693b8e99ce7c11c73d39fc75dde`，源码指纹为 `7fc0b40d9cb81bb03fcc8da99e952631d37931cef19eec139eba9cacf1c5844b`。健康候选和 503 回归的试验均在真实 PostgreSQL 中检查发布指针，并保存可回放的有界事实；工作区和暂存区均已清理。 [原生 OCI 试验](https://github.com/MaLaNg116/itervane/actions/runs/44901293360/job/136837551184)

对上述实际回执的首轮本机回环模型试验中，英文路径读齐证据但多次提交超过 480 字符的摘要，中文 503 路径完成。`5c63ab8` 明确工具字段长度，加入双语纠正反馈，两项回归验证修改摘要时无需重读证据。用相同回执复跑后两条路径均完成。

| 样例 | 正式回执 SHA-256 | 真实模型结果 |
| --- | --- | --- |
| 英文健康 | `e18cfe955a1d319196bbff57a0957acbfbddb14131358acae25eb4540358e18d` | 七轮、四次观察，覆盖源码、构建、基线和镜像，结论为 `observed` |
| 中文 503 | `fdf0fcc4d824585b400940717746915f801c741d0b6557656ffa9005b24675cc` | 六轮、三次观察，判断为 `checks_failed`，引用失败基线的证据给出建议 |

本机复跑角色代码的源码指纹为 `9f6f3e09efef4ecf759ff0f6e30db22be35d5aedd720eb45ba3f021fab216a1d`。自动 Worker 流转与发布资格分别进入后续验收。

修正版本 `767e96fa35fe02cb2825198dc798b297da48d3df` 在托管 KVM 上再次产生健康回执 `4fb2adb5cfafe76ccde4a0239a4a1d1cfd0d5cfe0cc502e83dff630c06a3ebf4` 与 503 回执 `0ca90ab94dd72cae698ac8bc3ba2cfc9d2770c1393f907208606e56ffce6c017`。本机同源码指纹模型对照再次通过。英文八轮四次观察，中文六轮三次观察，复验意见和清理证据均保留。 [同版本原生回执](https://github.com/MaLaNg116/itervane/actions/runs/44902685245/job/136841783434)

D-C 接入 Worker 状态流转和受控返修，D-D 接入双语门户和 MCP。
