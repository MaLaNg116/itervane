# P2-D3-D-A · 正式复验事实 Review Guide

本批依赖 [OCI 制品留存 #32](https://github.com/MaLaNg116/itervane/pull/32)，把 Runner 已核验的回执投影为将来复验 Agent 可读取的事实。首轮代码为 `988b996bd4a4cb9636bfe1f82228af829b561d75`。 [P2-D3-D 计划](../plans/p2-d3-d-formal-verification-agent.md)

1. `5285ca8` 在正式复验已有的授权、重领和证据持久化路径中，根据同一回执返回有界事实。事实绑定任务、run、项目、代次、原始固定提交、复验输入、候选和回执摘要。重读可以从相同回执重算相同内容。 [事务入口](../../packages/control-plane/src/runtime/formal-rescan.ts) · [事实投影](../../packages/control-plane/src/runtime/verification-evidence.ts)
2. 事实保留复扫比较、构建产物摘要、HTTP 失败原因、镜像和扫描摘要、按严重度的总数及可用归档。未申请、前置失败和实际检查失败使用独立状态。提供给后续模型的结构只含必要身份和有界元数据。 [事实契约](../../packages/contracts/src/formal-verification-evidence.ts)
3. `988b996` 在四条真实 PostgreSQL 回执路径中核对任务绑定和重放一致性，覆盖 HTTP 503 后镜像阶段未到达和包名留在底层证据的边界。追加原生 Worker 校验，令真实归档、manifest 和扫描总数能从投影复核。 [数据库验收](../../packages/control-plane/test/integration/inspections.test.ts) · [原生验收](../../packages/control-plane/test/native/worker-verification.ts)

本地 TypeScript、四项真实 PostgreSQL 回执对照和四组托管 KVM 流程均通过。KVM 固定在 `2ef7f3bba5021e28f4ee49eab08acd143771bfcd`，源码指纹 `4e0d87585e15f5b88884677eb5dfec1ede48f0af0f84cd1a6376be857f02c5ea` 与本地归档相同。原稿、模板和 npm 三组独立复扫的清理均确认。 [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44899950264)

| 样例 | 回执 SHA-256 | 核对结果 |
| --- | --- | --- |
| 健康候选 | `386bfae9afa9625250eedd152893d2769afdf20774101248de902460410adf3e` | 投影的 manifest `sha256:eb05bd911b056f74979a455d21db01c8518d9063e041f9f59e596f59d36d8f52` 与归档独立回读相同 |
| 回归候选 | `997dd785e51e6a68268c1f4623ef90e3bf244a34509f4ad8e4cd0e3a067688ab` | 基线记录 HTTP 503，镜像阶段记录为 `not_reached` |

复验角色、自动 Worker 流转及双语读面分别进入后续验收。发布候选仍由 P2-E 核验。
