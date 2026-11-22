# P3-B3d3 · 安装态正式诊断 Review Guide

[草稿 #82](https://github.com/MaLaNg116/itervane/pull/82) 接续 [门户 #81](https://github.com/MaLaNg116/itervane/pull/81)。实现和验收脚本固定在 `69b517b86823fd80017439892f2590e5d3e2ffb6`。 [实施计划](../plans/p3-b-operations-diagnosis-installation.md)

1. 配置已登记的环境、登记指纹和 Whiskers Read 密钥。API 启用运维入口，通过 `ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256` 提交正式诊断。Worker 比对它与实际安装模型的指纹。指纹由协议、规范化地址和模型标识生成，Whiskers 和模型凭证由 Worker 读取。 [配置](https://github.com/MaLaNg116/itervane/blob/69b517b86823fd80017439892f2590e5d3e2ffb6/packages/control-plane/src/config.ts#L20) · [示例](https://github.com/MaLaNg116/itervane/blob/69b517b86823fd80017439892f2590e5d3e2ffb6/.env.example)
2. 授权的发布详情能读取当前安装支持的诊断方式，门户据此呈现中英文入口。任务接收时确定模式和模型指纹，重试用原提交的输入。 [领取与启动](https://github.com/MaLaNg116/itervane/blob/69b517b86823fd80017439892f2590e5d3e2ffb6/packages/control-plane/src/runtime/worker.ts) · [门户](https://github.com/MaLaNg116/itervane/blob/69b517b86823fd80017439892f2590e5d3e2ffb6/packages/portal/src/pages/task-operations.tsx)
3. 托管原生用例在同一受保护容器发布后依次验收普通观察和正式诊断。正式任务由 MCP 提交，独立安装的 Worker 读取真实 Whiskers 与发布账本，结果经双语 HTTP 和 MCP 读回。工作流核对四类证据、发布绑定、审批后的发布次数和清理。 [原生用例](https://github.com/MaLaNg116/itervane/blob/69b517b86823fd80017439892f2590e5d3e2ffb6/packages/control-plane/test/native/worker-inspection.ts#L904) · [工作流](https://github.com/MaLaNg116/itervane/blob/69b517b86823fd80017439892f2590e5d3e2ffb6/.github/workflows/native-runner.yml)

在 Worker 环境配置模型后，从仓库根目录输出可共享的指纹。

```sh
pnpm exec tsx --env-file-if-exists=.env -e 'import { workerConfig } from "./packages/control-plane/src/config.ts"; import { configuredAuditModel } from "./packages/control-plane/src/runtime/formal-audit.ts"; const { auditModel } = workerConfig(); if (!auditModel) throw new Error("Configure the Worker model"); console.log(configuredAuditModel(auditModel).providerSha256);'
```

本机 TypeScript、224 项单元、PostgreSQL 17.12 专项五项及 Chrome 场景通过。真库专项覆盖本机 Anthropic HTTP 脚本模型、四类证据、双语响应、权限和旧观察兼容。原生端到端走相同协议的脚本模型，实模证据按独立运行归档。 [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44979952380) · [原生 Whiskers 回归](https://github.com/MaLaNg116/itervane/actions/runs/44979952343)

原生诊断首轮停在 `operations_formal_investigation`。`79deb06` 为后续复跑补充了白名单原因、证据类别及记录状态，区分调查、进程关闭和模型调用核对。 [首轮作业](https://github.com/MaLaNg116/itervane/actions/runs/44979952380/job/137078061605) · [复跑](https://github.com/MaLaNg116/itervane/actions/runs/44981348666)

后续夹具将详情、日志和指标三个原生只读工具全部加入同一白名单。同步主线的固定 Runner 镜像来源后，`4279f28ec137e8f455f0f2ea04df3a4f9359c111` 通过正式安装和受保护应用原生诊断。报告的源码指纹为 `9cccc6d452d3d43c578abcc53b0374d06b8dfa355554984ff7c31153651c7a24`。四类证据引用同一已发布容器，双语 HTTP 与 MCP 相符。诊断过程中只有原部署一次派发，执行槽及 Whiskers 夹具已清理。 [安装态原生证据](https://github.com/MaLaNg116/itervane/actions/runs/44990230823/job/137109454654) · [同版原生 Whiskers 检查](https://github.com/MaLaNg116/itervane/actions/runs/44990234055)

该版本使用真实 PostgreSQL 17.12 验证诊断查询、失败后接管和数据库时钟回退时的回执顺序。合入前核对 Worker 模型指纹、只读白名单、授权范围、双语回执和门户检查。模型使用 Anthropic 协议的确定性响应。 [PR 常规 CI](https://github.com/MaLaNg116/itervane/actions/runs/44990232708) · [分支常规 CI](https://github.com/MaLaNg116/itervane/actions/runs/44990229597)

复跑确认详情与发布证据已记录，日志读取被托管夹具的工具策略拦截。`9f9d327` 将该 Read 策略的允许列表限定为容器详情、日志和指标。 [复跑作业](https://github.com/MaLaNg116/itervane/actions/runs/44981348666/job/137082373936) · [固定后的 Read 策略](https://github.com/MaLaNg116/itervane/blob/9f9d3278a5451a95a6463aa23f9c18a3cf57181d/fixtures/whiskers/read-only-guardrails.json) · [复验](https://github.com/MaLaNg116/itervane/actions/runs/44982452271)
