# P3-B1 · Whiskers 日志与指标证据导读

依赖 [双语观察门户 #73](https://github.com/MaLaNg116/itervane/pull/73)。适配器、契约和协议回归固定于 `49cda7e3b4bfe0cb961e38af5e42cf8359a43057`，原生验收固定于 `edba27dee48e991351e3a0854fed55001799dac5`。 [P3-B 计划](../plans/p3-b-operations-agent.md)

1. Whiskers 0.15.0 的日志与指标使用同一固定地址、服务器与完整容器 ID。分别使用 40 尾行和一小时窗口，复用请求期限、响应限制及连接前、派发前和完成前的授权检查。 [适配器](https://github.com/MaLaNg116/itervane/blob/49cda7e3b4bfe0cb961e38af5e42cf8359a43057/packages/control-plane/src/runtime/whiskers-observation.ts#L102)
2. 日志只保留行数和警告、错误信号计数。原生指标核对容器前缀、窗口、样本数及数值顺序。指标缺失有明确覆盖状态。信号及指标供后续运维角色引用，结论依赖对照运行状态和发布记录。 [证据投影](https://github.com/MaLaNg116/itervane/blob/49cda7e3b4bfe0cb961e38af5e42cf8359a43057/packages/control-plane/src/runtime/whiskers-observation.ts#L43)
3. 原生验收在独立宿主使用临时 Read 密钥。对退出样例读取两行预知信号，对运行样例查实际采集点，并核对无样本和清理。同一生产适配器由测试直接调用。 [原生用例](https://github.com/MaLaNg116/itervane/blob/edba27dee48e991351e3a0854fed55001799dac5/packages/portal/test/native/whiskers.ts#L178) · [强制验收](https://github.com/MaLaNg116/itervane/blob/edba27dee48e991351e3a0854fed55001799dac5/.github/workflows/native-whiskers.yml)

本机 TypeScript、215 项单元检查通过，含四项新的日志和指标协议验证。实际采样与清理由托管独立宿主验收。B2 和 B3 接续运维 Agent 的证据选择与正式任务持久化。

固定验收版本 `d9678aedd1daae4eb95a49feff392d93630aa745` 通过托管 Whiskers 0.15.0 验收。必过条件包含停止容器的日志信号、运行容器的指标样本、明确无样本返回和夹具清理。 [原生验证](https://github.com/MaLaNg116/itervane/actions/runs/44972075364) · [脱敏验收材料](https://github.com/MaLaNg116/itervane/actions/runs/44972075364/artifacts/14733773893)

已合入版本 `ed7e7d1d7e28cf6ccd67b0504aa66a9f92007df8` 通过六项托管常规检查，与九组通过的 KVM 场景及原生 Whiskers 检查具有相同的非文档内容。 [托管常规检查](https://github.com/MaLaNg116/itervane/actions/runs/44974223013) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/44972075435) · [合入记录](https://github.com/MaLaNg116/itervane/commit/93258b8a7b3bfc432dc72d5adfe630362898c342)
