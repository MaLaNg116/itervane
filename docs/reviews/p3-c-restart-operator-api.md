# P3-C2c3c2a · 重启人工入口与双语回执导读

依赖 #100，固定代码与测试版本为 `e1ddf51f2079a960958c0a8bb7fe0c790f258fc6`。 [PR #101](https://github.com/MaLaNg116/itervane/pull/101) · [分批计划](../plans/p3-c-restart-operator.md)

1. `3f5ee2a` 在入队事务中复核门户客户端、项目、原批准人和授权代次，再核对已登记的专用写侧。续发沿用原任务版本、原生批准编号、调用指纹和幂等键，并对照 API 注入的同一写侧登记。 [入队事务](https://github.com/MaLaNg116/itervane/blob/e1ddf51f2079a960958c0a8bb7fe0c790f258fc6/packages/control-plane/src/service/operations-execution-admission.ts) · [续发事务](https://github.com/MaLaNg116/itervane/blob/e1ddf51f2079a960958c0a8bb7fe0c790f258fc6/packages/control-plane/src/runtime/operations-execution-lease.ts#L291)
2. `22b5249` 增加人工提交和续发 HTTP 路由。只有受信装机调用显式提供登记证明时才注册写路由。查询按当前项目授权读取任务、发布、原生审批编号、环境占用和恢复证据摘要。HTTP 和外部 MCP 共用投影，MCP 提供只读查询。 [HTTP 路由](https://github.com/MaLaNg116/itervane/blob/e1ddf51f2079a960958c0a8bb7fe0c790f258fc6/packages/control-plane/src/api.ts#L192) · [回执投影](https://github.com/MaLaNg116/itervane/blob/e1ddf51f2079a960958c0a8bb7fe0c790f258fc6/packages/control-plane/src/service/operations-restart-view.ts) · [外部 MCP](https://github.com/MaLaNg116/itervane/blob/e1ddf51f2079a960958c0a8bb7fe0c790f258fc6/packages/control-plane/src/mcp.ts)
3. `e1ddf51` 用 PostgreSQL 17.12 运行真实 HTTP 与 MCP 请求。初次入队和续发各重复两次，每种请求只提交一次。测试覆盖关闭态、错误安装、旧版本、错误原生批准编号、授权换代、撤销后转核对，以及已恢复回执的中英文与跨项目读权限。 [真库入口测试](https://github.com/MaLaNg116/itervane/blob/e1ddf51f2079a960958c0a8bb7fe0c790f258fc6/packages/control-plane/test/integration/inspections.test.ts#L4105)

TypeScript 和 246 项单元通过。最后一轮真库组合中三项新增用例通过，原有未知许可用例首次停在既有提案写入约束 `operations_proposal_authority_or_evidence`，同版本独立复跑通过。真库用例使用限定的下游响应。#100 的真实 Komodo 容器核对已验证独立身份可 Inspect 指定目标，真实后端拒绝写入和访问其他部署。 [专用读身份实证](https://github.com/MaLaNg116/itervane/actions/runs/45007441246) · [#101 托管检查](https://github.com/MaLaNg116/itervane/pull/101/checks)

标准 API 启动目前只注册回执查询。门户控件、等待过期和同一标准应用的真实平台审批、Whiskers 批准及实际恢复由后续批次接续。
