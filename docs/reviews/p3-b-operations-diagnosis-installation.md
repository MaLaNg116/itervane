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
