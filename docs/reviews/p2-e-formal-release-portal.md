# P2-E-B2 · 双语发布审批与外部 MCP 查询

本批基于 [本人确认与正式队列 #41](https://github.com/MaLaNg116/itervane/pull/41)。 [实施计划](../plans/p2-e-formal-release-approval.md)

1. `ed5c604` 增加 `GET /v1/tasks/:taskId/release`。同一事务核对当前项目权限、任务版本和代次，返回已有候选、项目内可选目标与当前可提交的决定。准备选项使用有界复验结果和已登记策略。真正冻结时再次读取并核对完整 Runner 回执。候选的审批按钮与写入命令共享人用 OIDC 客户端和所有者授权判据。 [聚合查询与人工决定](https://github.com/MaLaNg116/itervane/blob/ed5c604/packages/control-plane/src/service/formal-release.ts)
2. `9420c4e` 的外部 MCP 工具 `get_release_candidate` 直接复用候选 HTTP 查询。每次查询使用当前 scope 和项目权限。它返回同一固定候选及决定历史。 [MCP 工具](https://github.com/MaLaNg116/itervane/blob/9420c4e/packages/control-plane/src/mcp.ts) · [一致性与撤权用例](https://github.com/MaLaNg116/itervane/blob/9420c4e/packages/control-plane/test/integration/inspections.test.ts)
3. `17f2fc2` 在任务详情展示候选指纹、目标版本、期限、镜像风险、复验证据和决定历史。任务版本、运行代次、候选指纹或可用权限变化都会清除待确认界面。确认、拒绝和撤销使用相同的键盘可操作对话框。一次网络失败后重试仍使用原来的幂等键。批准状态在后端记录后显示为已入队。证据折叠遵循减少动效设置。 [任务发布面板](https://github.com/MaLaNg116/itervane/blob/17f2fc2/packages/portal/src/pages/task-release.tsx)
4. `d718aa1` 使用 Chrome、真实 Keycloak 登录与 PostgreSQL 项目权限验证两项浏览器流程。审批对话框核对完整指纹、取消、失效、重试、本人确认记录和撤销，另一个流程覆盖只读成员和撤权。冻结与决定响应在浏览器内使用固定契约样本。HTTP、MCP 的同源记录和正式队列由 PostgreSQL 套件验证，真实 KVM 回执与队列证据在前置批次及托管回归验证。 [浏览器场景](https://github.com/MaLaNg116/itervane/blob/d718aa1/packages/portal/test/browser/portal.spec.ts)

本机 TypeScript、163 项单元与两项浏览器专项通过。首轮真实 PostgreSQL 集成的新增覆盖通过，共 137 项通过，现有 Agent 检查点续跑用例返回 `requires_human`。固定 `d718aa1e5c5dd156ba42a559f73d8f4f55ca9c48` 全量复跑 138 项通过，源码指纹为 `56747ad6a4b9fc4a14d2d38b01fbde23b78cd5c651dd6be5735331539afbe472`。该次波动的原因仍待确认。 [PR #42](https://github.com/MaLaNg116/itervane/pull/42) · [托管 KVM 验收](https://github.com/MaLaNg116/itervane/actions/runs/44917062529)

蓝图中的外部 MCP 发布申请继续复用冻结命令。E-C 和 E-D 负责制品导入、Komodo 执行、对端核对与 P2 真实出口。
