# P3-C3-D2b · 关联修复的 HTTP 与 MCP 入口

接续 #131。接口代码固定于 `1e92d92108d8a6b704a1f9200588260cf05a3fe9`，用例固定于 `0ed721c68eb7779f32bdb51ba63cc76533f35926`。 [实施计划](../plans/p3-c-linked-repair-interfaces.md) · [PR #132](https://github.com/MaLaNg116/itervane/pull/132)

1. 从诊断任务的当前运行与已核验诊断读取提案状态。待确认提案重新核对固定发布、源码、有效期和提出人的授权代次。确认后通过准入记录查找关联任务的当前运行。 [授权读面](https://github.com/MaLaNg116/itervane/blob/1e92d92108d8a6b704a1f9200588260cf05a3fe9/packages/control-plane/src/service/operations-repair-workflow.ts#L21)
2. HTTP 与 MCP 共用准备和查询服务。写入 MCP 工具要求 `itervane:write`。准备服务从登记环境和诊断摘要确定发布与源码。签名身份由域服务按项目授权核对。 [MCP 工具](https://github.com/MaLaNg116/itervane/blob/1e92d92108d8a6b704a1f9200588260cf05a3fe9/packages/control-plane/src/mcp.ts#L73) · [范围查询与准备](https://github.com/MaLaNg116/itervane/blob/1e92d92108d8a6b704a1f9200588260cf05a3fe9/packages/control-plane/src/service/operations-repair-workflow.ts#L80)
3. 门户所有者使用原提案指纹确认。正式准入服务在同一事务关联任务并入队，重复确认返回已创建的任务。关联任务接续正式 Runner、复验与独立发布审批。 [HTTP 路由](https://github.com/MaLaNg116/itervane/blob/1e92d92108d8a6b704a1f9200588260cf05a3fe9/packages/control-plane/src/api.ts#L223) · [确认事务](https://github.com/MaLaNg116/itervane/blob/1e92d92108d8a6b704a1f9200588260cf05a3fe9/packages/control-plane/src/service/operations-repair-admission.ts#L21)

本地 TypeScript、253 项单元及 8 项 PostgreSQL 17.12 专项通过。真库用例覆盖中英文 HTTP 与真实 MCP、只读凭证、项目授权撤回、错误摘要和指纹、并发确认重放、发布替换及停止诊断回归。身份使用签名测试令牌，下游观测使用夹具。正式浏览器与 HTTP、MCP、原生发布的组合验收列在后续子批。 [协议专项](https://github.com/MaLaNg116/itervane/blob/0ed721c68eb7779f32bdb51ba63cc76533f35926/packages/control-plane/test/integration/inspections.test.ts#L3246) · [原生关联修复导读](p3-c-native-linked-health.md)
