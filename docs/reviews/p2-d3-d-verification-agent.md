# P2-D3-D-B · 正式复验 Agent Review Guide

本批依赖 [复验事实 #33](https://github.com/MaLaNg116/itervane/pull/33)。首次原生试验代码为 `efb21ac85f9c182884abc56f413c6f2488a72291`。 [实施计划](../plans/p2-d3-d-verification-agent.md)

1. `0aefef5` 将正式复验接入现有 LangGraph。角色只能读取当前回执的有限事实，HTTP 基线决定是否提供镜像观察。完成时算法重新推导比较与覆盖结果，模型说明和建议须引用本轮实际观察。恢复入口再次核对每项观察的固定摘要。 [角色入口](../../packages/agent/src/formal-verification.ts) · [执行循环](../../packages/agent/src/harness.ts) · [完成判定](../../packages/agent/src/results.ts)
2. `f6df2ac` 验证英文健康路径增加镜像观察，中文 503 路径保留失败与建议。非法申请、提前索取镜像、伪造引用均无法取得复验结论。 [模型对照](../../packages/verification/test/unit/formal-verification-agent.test.ts)
3. `c91c803` 正式入口复用已记录的 Runner 回执，在当前执行租约下发布 `verify:<runId>` 检查点。输入、回执、Worker、fence 和代次均有数据库约束。已保留的一次只读观察可由新 Worker 续作，原执行者和撤权后的调用无法读取进度。 [正式入口](../../packages/control-plane/src/runtime/formal-verification.ts) · [检查点约束](../../packages/control-plane/migrations/0025_formal_verification_checkpoint.sql)
4. `efb21ac` 用托管 Runner 的真实候选和 503 回归试验正式入口，保存独立模型试验所需的冻结输入及有界事实。持久化角色试验使用脚本适配器，另可用 `pnpm probe:formal-verify --live <runner-worker-build.json>` 在本机已授权的回环模型上复跑。 [原生试验](../../packages/control-plane/test/native/worker-verification.ts) · [真实模型入口](../../packages/verification/src/entries/formal-verification.ts)

本机 TypeScript、51 项 Agent 回归和四条真实 PostgreSQL 回执对照通过。恢复对照确认新 Worker 延续已预留的观察，模型共运行五轮，Runner 只派发一次。托管 Runner 和真实模型结果待归档。D-C 接入 Worker 状态流转和受控返修，D-D 接入双语门户和 MCP。
