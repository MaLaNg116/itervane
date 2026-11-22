# P3-B2 · 运维 Agent 调查循环导读

接续 [Whiskers 日志与指标 #74](https://github.com/MaLaNg116/itervane/pull/74)。调查循环固定于 `0b1f8fbf859dd07fc205f555140a2f233b003b4d`，验收固定于 `27c4ea11b6751b163442189d2a1c477dcff84882`。 [分批计划](../plans/p3-b-operations-harness.md)

1. 运维角色复用预算、权限核对和同步检查点。模型依据观察选择状态、发布、日志及指标，工具参数只有证据类别。宿主校验冻结任务、当前正式发布、容器和服务器。模型上下文使用已投影的事实及证据编号。 [运维入口](https://github.com/MaLaNg116/itervane/blob/0b1f8fbf859dd07fc205f555140a2f233b003b4d/packages/agent/src/formal-operations.ts#L32) · [回执边界](https://github.com/MaLaNg116/itervane/blob/0b1f8fbf859dd07fc205f555140a2f233b003b4d/packages/agent/src/harness.ts#L275)
2. 结论区分平台确认的事实、带引用的假设与建议。日志信号支持应用错误假设，平均内存使用率达到 85% 可作为内存压力线索。重启建议需要已退出或失效的容器，恢复建议还需要不同镜像的前一已核验发布。平台根据已观察版本填充恢复目标，按显示语言生成文案。 [结论校验](https://github.com/MaLaNg116/itervane/blob/0b1f8fbf859dd07fc205f555140a2f233b003b4d/packages/agent/src/operations-results.ts#L34)
3. 恢复时用任务、来源版本和模型配置重新核对检查点。预留的只读观察使用同一操作 ID。重连时再次核对权限和结果引用。 [恢复核对](https://github.com/MaLaNg116/itervane/blob/0b1f8fbf859dd07fc205f555140a2f233b003b4d/packages/agent/src/state.ts#L101) · [真库回归](https://github.com/MaLaNg116/itervane/blob/27c4ea11b6751b163442189d2a1c477dcff84882/packages/verification/test/integration/agent-checkpoints.test.ts#L103)

本机 TypeScript 和 223 项单元检查通过。独立 PostgreSQL 17.12 的四项检查点测试通过，含预留后重连、配置不符阻断、完成结果重放和原交付回归。脚本模型证明状态变化引出不同调查路径，并验证虚构引用、无数据指标、跨目标与撤权。 [运维专题用例](https://github.com/MaLaNg116/itervane/blob/27c4ea11b6751b163442189d2a1c477dcff84882/packages/verification/test/unit/formal-operations-agent.test.ts)

使用 `pnpm probe:operations-agent --live` 在本机回环运行 Anthropic 兼容实模，两个可信样例均形成可复核结论。固定源码指纹 `2a5b7edb6ec1894643b853b1b01582e1cd6c7b7b5c8e55105fee46a1b8a30ae2`。

| 样例 | 取得的观察 | 建议 | 模型轮次 |
| --- | --- | --- | --- |
| 中文，容器已退出 | 状态、发布、日志 | 审查重启 | 6 |
| 英文，容器运行中 | 状态、发布、日志、指标 | 继续观察 | 8 |

评测使用受控证据，真实运维任务的授权读取、持久化与原生闭环接续于 B3。 [可复跑入口](https://github.com/MaLaNg116/itervane/blob/27c4ea11b6751b163442189d2a1c477dcff84882/packages/verification/src/entries/operations-agent.ts)
