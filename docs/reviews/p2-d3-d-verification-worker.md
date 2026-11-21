# P2-D3-D-C1 · 正式 Worker 复验接续 Review Guide

本批接续已合入的 [复验角色 #34](https://github.com/MaLaNg116/itervane/pull/34)。任务在同一执行租约下把固定源码或已记录修复件交给正式复验。 [实施计划](../plans/p2-d3-d-verification-worker.md)

1. `8ac4aba` 校验 Worker 的静态复验配置。在受控环境中配置 `ITERVANE_VERIFICATION_PROFILE`、模型和已验证 Runner，使用同一 Runner 镜像并绑定扫描、构建、基线与 OCI 输入。 [配置示例](../../.env.example) · [配置校验](../../packages/control-plane/src/config.ts)
2. `dc3eb08` 新增一次性发布的复验结论。保存前从记录的回执重算事实和意见引用，数据库核对当前任务、代次、执行权、回执和检查点。发布事件与释放执行槽同事务提交。 [发布函数](../../packages/control-plane/src/service/verification-result.ts) · [数据库约束](../../packages/control-plane/migrations/0026_formal_verification_result.sql)
3. `08b0cf2` 在审计或修复的事务内固定复验输入，设置 `verification_pending`。新 Worker 从该阶段续作并校验原有配置和权限。缺少有效回执时按不可用或待核对处理，保留核对记录。 [Worker 调度](../../packages/control-plane/src/runtime/worker.ts) · [输入绑定](../../packages/control-plane/src/runtime/verification-input.ts)
4. `fec1e95` 和 `98eb7cb` 用真实 PostgreSQL 验证原稿、修复件、503 回归、重领、配置变化、撤权和清理未知。故障注入验证复验事件落库失败时，结果一起回滚，已留下的真实 Runner 回执仍可核对。 [事务回归](../../packages/control-plane/test/integration/inspections.test.ts)
5. `05f9d45` 用正式 Worker 入口执行两个隔离标准候选，验证真实队列、复验结果、清理和制品证明相互对应。原生验收脚本提供可做真实模型试验的有限事实。 [原生流程](../../packages/control-plane/test/native/worker-inspection.ts)
6. `6dec5d0` 修复系统时钟回拨时对已停止检查点的错误拒绝。前两次全量复跑偶发丢失结论，诊断复现显示三个角色都可能受影响，已观测到结果读取时超出当前时间窗 654 毫秒和 1,585 毫秒。已停止状态保留结论，活动状态继续检查期限及身份绑定。 [恢复校验](../../packages/agent/src/state.ts) · [确定性回归](../../packages/verification/test/unit/formal-verification-agent.test.ts)

本机 TypeScript 校验及 163 项单元测试通过。真实 PostgreSQL 全量复跑和托管 KVM 的正式流转验收继续记录在本文件。

D-C2 接续受控返修代次与预算。D-D 提供双语门户及外部 MCP 的结果视图。P2-E 在实际发布前独立核对候选和人工批准。
