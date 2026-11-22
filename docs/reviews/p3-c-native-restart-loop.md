# P3-C2c3c3a · 同一应用的原生重启联验导读

依赖 #103，固定验收代码为 `e5c1d4458e3a867d77362eef90f4515c662a5a17`。 [PR #104](https://github.com/MaLaNg116/itervane/pull/104) · [阶段计划](../plans/p3-c-native-restart-loop.md)

1. `98d53f1` 为已有合成应用开启原生 Whiskers Operator，以及绑定到登记范围的单工具写凭证和读取凭证。Komodo 为已发布目标签发独立 Inspect 身份。确定性模型根据实际容器状态选择读证据，停止状态只读取容器和发布事实后给出重启建议。 [原生 Whiskers 安装](https://github.com/MaLaNg116/itervane/blob/e5c1d4458e3a867d77362eef90f4515c662a5a17/packages/portal/test/native/whiskers-restart-scope.ts) · [模型分支](https://github.com/MaLaNg116/itervane/blob/e5c1d4458e3a867d77362eef90f4515c662a5a17/packages/control-plane/test/native/audit-provider.ts)
2. `8a57303` 在同一次托管发布中停止已经确认归属的容器，运行安装后的诊断与重启 Worker。验收走真实平台 HTTP 和 MCP，检查无批准请求、非门户身份、相同请求重试、独立 Operator 批准、原生审计与恢复回执。结果核验在授权前后分别观察停止状态，并对比恢复后的同一容器、启动时间和受保护健康。 [原生验收入口](https://github.com/MaLaNg116/itervane/blob/e5c1d4458e3a867d77362eef90f4515c662a5a17/packages/control-plane/test/native/worker-inspection.ts) · [审批和恢复断言](https://github.com/MaLaNg116/itervane/blob/e5c1d4458e3a867d77362eef90f4515c662a5a17/packages/control-plane/test/native/restart-proof.ts)
3. `e5c1d44` 在既有 KVM 运维场景打包专用 Worker，托管验收读取关联证明，要求一次原生操作、一次续发应答、恢复证据及环境和槽位释放。控制面身份签发和模型使用确定性夹具，Komodo、Whiskers、Keycloak 保护入口和应用运行状态使用实际服务。 [Worker 安装](https://github.com/MaLaNg116/itervane/blob/e5c1d4458e3a867d77362eef90f4515c662a5a17/fixtures/runner/run-qualified-session.sh) · [证据闸门](https://github.com/MaLaNg116/itervane/blob/e5c1d4458e3a867d77362eef90f4515c662a5a17/.github/workflows/native-runner.yml)

TypeScript、246 项单元、Node Worker 打包及脚本语法已在本机检查通过。完整原生场景等待托管 KVM 执行。故障接管补验和自托管参考安装在 C2c3c3b/c。 [托管检查](https://github.com/MaLaNg116/itervane/pull/104/checks)
