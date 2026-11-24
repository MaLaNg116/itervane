# P3-C3-D3a · 门户事件、停止诊断与关联修复

接续 [PR #132](https://github.com/MaLaNg116/itervane/pull/132)。控制面固定于 `6e65ad2a84ef6fe7d4dfe75c87f52e5103b70576`，门户实现固定于 `8ae39e68a7d851dd03cee44a5892869d22a0d5b3`，浏览器用例固定于 `dad3c6323411a42a101d1f0847cbffde48aa95e3`。 [实施计划](../plans/p3-c-incident-portal.md)

1. 发布详情从已核验候选取得项目、环境与发布编号，只显示该发布的健康样本及事件。诊断和修复任务共享事件摘要和导航。披露使用已有 GSAP 组件，遵循浏览器减少动效偏好。 [发布和任务事件组件](https://github.com/MaLaNg116/itervane/blob/8ae39e68a7d851dd03cee44a5892869d22a0d5b3/packages/portal/src/pages/task-incidents.tsx#L12)
2. 任务事件读面只为门户所有者投影停止入口。确认请求固定事件、发布及可选的恢复执行，提交时沿用已有的授权复核、并发串行化和停止凭据。界面从同一事件重新读取已停止状态。 [权限投影](https://github.com/MaLaNg116/itervane/blob/6e65ad2a84ef6fe7d4dfe75c87f52e5103b70576/packages/control-plane/src/service/operations-incidents-view.ts#L110) · [确认界面](https://github.com/MaLaNg116/itervane/blob/8ae39e68a7d851dd03cee44a5892869d22a0d5b3/packages/portal/src/pages/task-incidents.tsx#L42)
3. 已核验的代码排查建议可准备关联修复。门户按当前提案指纹确认，已部署补丁时要求固化后的 Git 提交。审批失效时关闭对话框。任务重新进入 Runner、独立复验和单独发布审批。 [提案界面](https://github.com/MaLaNg116/itervane/blob/8ae39e68a7d851dd03cee44a5892869d22a0d5b3/packages/portal/src/pages/task-operations-repair.tsx#L15)

本地 TypeScript 和 PostgreSQL 17.12 的 3 项事件及停止入口回归通过。Chrome、Keycloak 和 PostgreSQL 运行的新增浏览器场景通过，覆盖中英文、键盘展开与退出确认、恢复执行绑定、授权变化和关联任务导航。浏览器响应夹具控制下游事件和放行状态，真实停机、修复与恢复的组合证据由后续托管场景提供。浏览器报告源码指纹为 `3a40b4e799848a2e620f11f7a7cd329858279116ffdcdb2c0ff0003bef8830d4`。 [浏览器用例](https://github.com/MaLaNg116/itervane/blob/dad3c6323411a42a101d1f0847cbffde48aa95e3/packages/portal/test/browser/portal.spec.ts#L1013)
