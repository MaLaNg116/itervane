# P3-C2a · Whiskers 原生重启协议导读

以 #85 的门户审批为基线。代码快照为 `ede9ca0561bc39172a4ad36345f8b04559cee737`。 [PR #87](https://github.com/MaLaNg116/itervane/pull/87) · [前置 PR #85](https://github.com/MaLaNg116/itervane/pull/85) · [处置执行计划](../plans/p3-c-operations-execution.md)

1. `05a75fa` 抽取只连接已登记 Whiskers 来源的 MCP 会话。校验版本、工具范围、时限及响应大小。每个会话只发一个工具调用，重启传输拒绝第二次写入请求。原有观察入口继续使用 Read 凭证并在结果返回前核对权限。 [有界传输](https://github.com/MaLaNg116/itervane/blob/ede9ca0561bc39172a4ad36345f8b04559cee737/packages/control-plane/src/runtime/whiskers-mcp.ts) · [观察适配器](https://github.com/MaLaNg116/itervane/blob/ede9ca0561bc39172a4ad36345f8b04559cee737/packages/control-plane/src/runtime/whiskers-observation.ts)
2. `83a358c` 固定 `restart_container` 参数。连接和派发前均向调用者提供动作阶段及目标，续发时还提供已存的批准 ID。首次回执接受新批准，续发期间仅接受同一待批 ID 或已应答。出现换号、提前应答、传输中断及格式未知时返回 `result_unknown`。 [重启适配器](https://github.com/MaLaNg116/itervane/blob/ede9ca0561bc39172a4ad36345f8b04559cee737/packages/control-plane/src/runtime/whiskers-restart.ts) · [专项测试](https://github.com/MaLaNg116/itervane/blob/ede9ca0561bc39172a4ad36345f8b04559cee737/packages/control-plane/test/unit/whiskers-restart.test.ts)
3. `ede9ca0` 在固定 Whiskers 版本和专用测试容器上运行同一适配器。由原生页面确认全长容器参数，再检查启动时间、HTTP 健康和原生审计。批准后即使重新连接也只批准原调用，继续保留另一凭证和另一容器的负向对照。 [托管场景](https://github.com/MaLaNg116/itervane/blob/ede9ca0561bc39172a4ad36345f8b04559cee737/packages/portal/test/native/whiskers.ts) · [实测工作流](https://github.com/MaLaNg116/itervane/blob/ede9ca0561bc39172a4ad36345f8b04559cee737/.github/workflows/native-whiskers.yml)

本机 TypeScript 和 229 项单元通过，其中五项覆盖原生重启边界，十二项覆盖既有观察适配器。托管原生 Whiskers 与 Runner 正在回归。 [Native Whiskers](https://github.com/MaLaNg116/itervane/actions/runs/44985016597) · [Native Runner](https://github.com/MaLaNg116/itervane/actions/runs/44985016671)

正式派发仍由后续批次接入。调用者应持久化批准 ID 和执行意图，保持环境互斥，并用独立证据验证容器版本和受保护入口。适配器的已应答状态只记录原生工具回复。
