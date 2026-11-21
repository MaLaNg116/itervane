# P2-E-B1 · 正式候选的人工确认与队列事务

基于 [候选冻结 #40](https://github.com/MaLaNg116/itervane/pull/40)。所有者通过人用 OIDC 客户端确认固定候选。数据库将决定、任务状态、审计事件和正式队列唤醒一起提交。 [实施计划](../plans/p2-e-formal-release-approval.md)

1. `007fb27` 在 `POST /v1/release-candidates/:candidateId/decisions` 校验登录客户端、所有者授权、候选指纹、决定版本和幂等键。确认前从当前正式复验重新核对结果与归档证据，在同一事务读取当前环境配置和数据库时间。拒绝、取消和派发前撤销有独立状态。 [决定服务](https://github.com/MaLaNg116/itervane/blob/007fb27/packages/control-plane/src/service/formal-release.ts) · [操作绑定](https://github.com/MaLaNg116/itervane/blob/007fb27/packages/control-plane/migrations/0030_formal_release_approval.sql)
2. `release-formal-v1` 使用固定操作 ID 作唤醒和查证键，载荷只携带这一 ID。源码工作流的领取和恢复会跳过已入发布队列的任务。取消或撤销在同一事务阻断排队记录。 [队列事务](https://github.com/MaLaNg116/itervane/blob/007fb27/packages/control-plane/src/runtime/release-queue.ts) · [恢复分流](https://github.com/MaLaNg116/itervane/blob/007fb27/packages/control-plane/src/runtime/coordinator.ts)
3. `9718a6a` 在真实 PostgreSQL 验证错误登录客户端、已替换候选、伪造操作、入队失败回滚、重复确认、撤权重授、撤销与取消。托管原生流程使用第二代实际镜像候选和测试签发者记录本人确认，检查同事务操作与正式队列。 [数据库路径](https://github.com/MaLaNg116/itervane/blob/9718a6a/packages/control-plane/test/integration/inspections.test.ts) · [原生路径](https://github.com/MaLaNg116/itervane/blob/9718a6a/packages/control-plane/test/native/worker-inspection.ts)

本机 TypeScript、九项真实 PostgreSQL 专项和 138 项全量集成已通过。数据库测试固定 `9718a6aabe1b9af391e87b2f2a94b3de440a35e1`，源码指纹为 `028830020f3fcde6d43c1097a356ba5b25b389dde363a710242c5a0af545e89d`。 [托管验收](https://github.com/MaLaNg116/itervane/actions/runs/44914829105)

B2 添加人用门户与外部 MCP 的同源投影。C 接续制品导入、Komodo 派发和实际运行核对。
