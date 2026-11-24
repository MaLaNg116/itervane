# P3-C3-D2a · 停止自动诊断与外部 MCP 读取

接续 #130。MCP 工具固定为 `0abd32f42ccab3c07b0ba1678567238b852d7dbc`，停止接口与迁移为 `3df6f8b99b92d89b780222cc4b02eccd8249d651`，专项用例为 `e6348c2e32c5f4250b828253da00d1d334dec482`。 [实施计划](../plans/p3-c-incident-actions.md) · [PR #131](https://github.com/MaLaNg116/itervane/pull/131)

1. `list_operations_incidents` 和 `get_task_incident` 调用与 HTTP 相同的授权查询，使用已有 MCP 资源受众与读取作用域。 [MCP 注册与分发](https://github.com/MaLaNg116/itervane/blob/0abd32f42ccab3c07b0ba1678567238b852d7dbc/packages/control-plane/src/mcp.ts#L129)
2. 门户所有者按项目、登记环境、事件及原发布绑定停止自动诊断。环境锁串行化停止、健康记录及调度。停止时间、执行人和授权代次入库，重复调用读取原记录，数据库拒绝后改停止证据。后续采样继续归属原事件，自动任务的权限检查从持久化停止状态读取。 [停止接口](https://github.com/MaLaNg116/itervane/blob/3df6f8b99b92d89b780222cc4b02eccd8249d651/packages/control-plane/src/service/operations-incident-stop.ts#L18) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/3df6f8b99b92d89b780222cc4b02eccd8249d651/packages/control-plane/migrations/0070_operations_incident_operator_stop.sql#L8)

本地 TypeScript、Drizzle 一致性和 PostgreSQL 17.12 专项通过，覆盖并发重放、普通 API 凭证与错误发布拒绝、运行中租约失去权限、排队任务无法领用、停止后的采样及双语 HTTP/MCP 一致性。该组用例使用真实 HTTP 和 MCP 协议及签名测试身份，下游部署与诊断证据由夹具提供。关联修复提案、门户确认及浏览器将在后续子批验收。 [真库用例](https://github.com/MaLaNg116/itervane/blob/e6348c2e32c5f4250b828253da00d1d334dec482/packages/control-plane/test/integration/inspections.test.ts#L3435)
