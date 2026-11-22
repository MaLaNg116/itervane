# P3-C2d4b · 版本恢复确认与双语回执导读

本批依赖 #113，固定代码与测试为 `443fcec09898152f8f37e73c1a40ddaa85d65b1d`。 [实施计划](../plans/p3-c-operations-restore.md) · [PR #114](https://github.com/MaLaNg116/itervane/pull/114)

1. 按诊断任务读取回执。HTTP `/v1/tasks/:taskId/operations-restore` 和 MCP `get_operations_restore` 共用范围校验及读取服务。执行状态、原生更新和最新核验在同一数据库快照读取。核验成功还要匹配批准的发布版本、派发更新、回执摘要及环境结算时间。对外返回版本、摘要和编号。 [读取与核验](https://github.com/MaLaNg116/itervane/blob/443fcec09898152f8f37e73c1a40ddaa85d65b1d/packages/control-plane/src/service/operations-restore-view.ts#L16) · [权限与双语真库](https://github.com/MaLaNg116/itervane/blob/443fcec09898152f8f37e73c1a40ddaa85d65b1d/packages/control-plane/test/integration/inspections.test.ts#L2993)
2. 门户提交使用服务端装机范围和已冻结的提案指纹。事务锁住诊断任务和环境，重验门户所有者、原审批人、授权代次、有效期、当前发布实例及 Komodo 登记。并发提交复用同一处置，撤销取消待派发任务。 [提交校验](https://github.com/MaLaNg116/itervane/blob/443fcec09898152f8f37e73c1a40ddaa85d65b1d/packages/control-plane/src/service/operations-execution-admission.ts#L57) · [真库准入](https://github.com/MaLaNg116/itervane/blob/443fcec09898152f8f37e73c1a40ddaa85d65b1d/packages/control-plane/test/integration/inspections.test.ts#L3052)
3. 门户复用重启执行区的确认、刷新和 GSAP 折叠。关键信息是获批镜像、恢复后实际版本、原生更新编号、核验时间和环境占用。批准或提交权限失效时关掉待确认弹窗。 [门户接线](https://github.com/MaLaNg116/itervane/blob/443fcec09898152f8f37e73c1a40ddaa85d65b1d/packages/portal/src/pages/task-operations-execution.tsx#L30) · [浏览器回归](https://github.com/MaLaNg116/itervane/blob/443fcec09898152f8f37e73c1a40ddaa85d65b1d/packages/portal/test/browser/portal.spec.ts#L907)

TypeScript、248 项单元和六项 PostgreSQL 17.12 专项通过。实际 Chrome 与 Keycloak 验证恢复和重启两个门户场景，处置响应由测试路由控制，浏览器报告源码指纹为 `e27c14c18e168a11a801ec1fcfed251785bc4046322459cf2786e63449ec6637`。首次运行在浏览器准备时失败，最终使用本机缓存的 Keycloak 26.8.2 测试镜像通过。浏览器脚本等待登录回调拿到会话并安装动效观测，再运行队列和回执断言。

门户写入口由服务端传入待验收的装机范围。外部 MCP 提供只读回执。公开自托管启动接线与实际双版本恢复验收归 C2d4c，验收通过后启用恢复提交入口。 [托管检查](https://github.com/MaLaNg116/itervane/pull/114/checks)
