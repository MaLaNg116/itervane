# P2-D3-D-C1 · 正式 Worker 复验接续 Review Guide

本批接续已合入的 [复验角色 #34](https://github.com/MaLaNg116/itervane/pull/34)。任务在同一执行租约下把固定源码或已记录修复件交给正式复验。 [实施计划](../plans/p2-d3-d-verification-worker.md)

1. `8ac4aba` 校验 Worker 的静态复验配置。在受控环境中配置 `ITERVANE_VERIFICATION_PROFILE`、模型和已验证 Runner，使用同一 Runner 镜像并绑定扫描、构建、基线与 OCI 输入。 [配置示例](../../.env.example) · [配置校验](../../packages/control-plane/src/config.ts)
2. `dc3eb08` 新增一次性发布的复验结论。保存前从记录的回执重算事实和意见引用，数据库核对当前任务、代次、执行权、回执和检查点。发布事件与释放执行槽同事务提交。 [发布函数](../../packages/control-plane/src/service/verification-result.ts) · [数据库约束](../../packages/control-plane/migrations/0026_formal_verification_result.sql)
3. `08b0cf2` 在审计或修复的事务内固定复验输入，设置 `verification_pending`。新 Worker 从该阶段续作并校验原有配置和权限。缺少有效回执时按不可用或待核对处理，保留核对记录。 [Worker 调度](../../packages/control-plane/src/runtime/worker.ts) · [输入绑定](../../packages/control-plane/src/runtime/verification-input.ts)
4. `fec1e95` 和 `98eb7cb` 用真实 PostgreSQL 验证原稿、修复件、503 回归、重领、配置变化、撤权和清理未知。故障注入验证复验事件落库失败时结果一起回滚，已记录的扫描回执仍可核对。 [事务回归](../../packages/control-plane/test/integration/inspections.test.ts)
5. `05f9d45` 用正式 Worker 入口执行两个隔离标准候选，验证真实队列、复验结果、清理和制品证明相互对应。原生验收脚本提供可做真实模型试验的有限事实。 [原生流程](../../packages/control-plane/test/native/worker-inspection.ts)
6. `6dec5d0` 修复系统时钟回拨时对已停止检查点的错误拒绝。前两次全量复跑偶发丢失结论，诊断复现显示三个角色都可能受影响，已观测到结果读取时超出当前时间窗 654 毫秒和 1,585 毫秒。已停止状态保留结论，活动状态继续检查期限及身份绑定。 [恢复校验](../../packages/agent/src/state.ts) · [确定性回归](../../packages/verification/test/unit/formal-verification-agent.test.ts)

以 `49d1c866c612e5e371a97f5901f01937987dfaa5` 验证了 TypeScript、163 项单元和 129 项真实 PostgreSQL 17 集成。数据库测试源码指纹为 `7b2219e68b8a69473835e9ac5f1d710052fa86b65d7afc11b8f44c6197dcbcf6`。本地数据库验证使用固定的 Runner 证据夹具。常规 CI 的确定性、门户和扫描器检查已通过，正式 Worker 与真实隔离客体联动由托管 KVM 单独验收。 [常规 CI](https://github.com/MaLaNg116/itervane/actions/runs/44905416353) · [正式流转实证](https://github.com/MaLaNg116/itervane/actions/runs/44905411730)

标准 OCI 验收用生产 Worker 接受两条真实任务，每条有唯一复扫回执和数据库结论。英文本机模型对同版本健康回执七轮查询四段证据，中文 503 回执六轮读取三段证据并保留失败。两条路的 Runner 发布指纹与本地相同，客体和暂存区均清理。健康归档的独立 manifest 与扫描回执一致。 [KVM 与存档](https://github.com/MaLaNg116/itervane/actions/runs/44905411730/job/136849812071)

| 样例 | 复验结论 SHA-256 | 正式回执 SHA-256 |
| --- | --- | --- |
| 英文健康 | `559192b0b0a01d6881eae858521203d5a89c0264c3c78842e69dcedeb0da3b2a` | `d2b557cae485bbae08451aa821fe58d98f72acb7890a741560da0c1e44f0c7cc` |
| 中文 503 | `8536b510e9209ae7ff8e019f3c89d7eb0cb00f82ee5f883d4fbeb76b6a3b05bc` | `fd505c6e82501f1a6bf576d6161f9c9bd5da7257661056f06dc460d6031a9a9c` |

四组原生验收完成后，检查最终文档版本 `1329646be83cf6c69d48946c8c99ef88124a281a` 的变更仅涉及导读与索引，并核对该提交的常规 CI。PR 已以 `26f01aca8ccf1edddc91d7d24d03528517a7bb1c` 合入。 [四组原生验收](https://github.com/MaLaNg116/itervane/actions/runs/44905411730) · [合并记录](https://github.com/MaLaNg116/itervane/pull/35)

[D-C2](p2-d3-d-repair-retry.md) 接续受控返修代次与预算。D-D 提供双语门户及外部 MCP 的结果视图。P2-E 在实际发布前独立核对候选和人工批准。
