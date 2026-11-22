# P3-C1b2 · 双语处置提案与人工审批导读

本批基于人工决策 #84，代码版本为 `0a7e250fe98475a1a6dde0fbc5c7a8df378d5be1`。 [PR #85](https://github.com/MaLaNg116/itervane/pull/85) · [前置 PR #84](https://github.com/MaLaNg116/itervane/pull/84) · [实施计划](../plans/p3-c-operations-proposal-interfaces.md)

1. `a4faa26` 定义提案读面。读取时核对当前项目授权、已结算的诊断及提案指纹，再读决定历史。有效期、目标变更与授权变更影响当前状态。公开字段包括批准对象、当前与待恢复镜像摘要、版本化决定和可用操作。 [数据契约](https://github.com/MaLaNg116/itervane/blob/0a7e250fe98475a1a6dde0fbc5c7a8df378d5be1/packages/contracts/src/operations-proposal.ts) · [投影服务](https://github.com/MaLaNg116/itervane/blob/0a7e250fe98475a1a6dde0fbc5c7a8df378d5be1/packages/control-plane/src/service/operations-proposal-view.ts)
2. HTTP 与外部 MCP 共用提案投影。工具查询和请求提案分别需要对应 OAuth 范围，项目授权由领域服务再校验。门户决策只接受已配置客户端上的现任工作区所有者。生产入口随正式诊断配置启用。 [HTTP](https://github.com/MaLaNg116/itervane/blob/0a7e250fe98475a1a6dde0fbc5c7a8df378d5be1/packages/control-plane/src/api.ts) · [MCP](https://github.com/MaLaNg116/itervane/blob/0a7e250fe98475a1a6dde0fbc5c7a8df378d5be1/packages/control-plane/src/mcp.ts)
3. `4184496` 在诊断面板内展示中英文提案。复用 GSAP 证据展开组件和现有确认弹窗。弹窗列出具体镜像摘要，提交绑定提案 ID、指纹、决定版本和幂等标识。连接失败可复用该标识，服务端显示的提案或操作权限变化时关闭旧弹窗。 [门户入口](https://github.com/MaLaNg116/itervane/blob/0a7e250fe98475a1a6dde0fbc5c7a8df378d5be1/packages/portal/src/pages/task-operations-proposal.tsx)
4. `0a7e250` 在真实 Chrome 和 Keycloak 中切换两种角色与语言。维护者请求提案，所有者在独立会话中提交决定，模拟一次连接失败并复用原请求。降为查看者后决定入口不可见，项目撤权后面板消失。浏览器夹具提供已核验的诊断与提案响应，后端权限和持久化另由真库集成验证。 [浏览器场景](https://github.com/MaLaNg116/itervane/blob/0a7e250fe98475a1a6dde0fbc5c7a8df378d5be1/packages/portal/test/browser/portal.spec.ts) · [HTTP／MCP 真库场景](https://github.com/MaLaNg116/itervane/blob/0a7e250fe98475a1a6dde0fbc5c7a8df378d5be1/packages/control-plane/test/integration/inspections.test.ts)

| 验证 | 结果 |
| --- | --- |
| TypeScript 与单元 | `pnpm check` 通过，224 项单元通过 |
| PostgreSQL 17.12 | 4 项专项通过，包含跨 HTTP/MCP 查询、请求去重和门户决策的授权检查 |
| 真实浏览器 | Vite 生产构建通过，Chrome 与 Keycloak 的 1 项专项通过 |

C2 接入批准后的运维派发、下游确认和恢复验证。当前交付记录人工决定，并保留绑定版本、权限及失效原因供后续核对。

托管并发用例发现原断言遗漏决策服务随回执返回的任务 ID。修订断言后，使用 PostgreSQL 17.12 复测同一提案只有一个决定成功，另一个返回版本冲突，并核对成功回执关联原诊断任务。 [原托管检查](https://github.com/MaLaNg116/itervane/actions/runs/44983678709/job/137089535117)

## 主线同步后的复验

同步 #84 后，固定代码 `b95bdcfb7bbe3c97127dd51d685b4aa4bbe61b99` 通过 224 项单元、四项真实 PostgreSQL 17.12 专项和托管常规检查。复审覆盖门户审批客户端、项目权限、提案指纹及版本、英文与中文展示以及连接失败后的幂等键。 [常规检查](https://github.com/MaLaNg116/itervane/actions/runs/44996741041)

同版安装态运维场景首次在标准应用返修阶段提前退出。该次产物未包含完整的发布与诊断回执，无法确定退出原因。其他八项检查结束后单独重试该作业，第二次运行的九项检查全部通过。 [首次安装态运行](https://github.com/MaLaNg116/itervane/actions/runs/44996736228/job/137129269232) · [第二次运行](https://github.com/MaLaNg116/itervane/actions/runs/44996736228/attempts/2)

重试产物使用 PostgreSQL 17.12，包含第二代标准应用返修、同一已发布目标的容器、发布、日志和指标证据。HTTP 与 MCP 回执一致，临时 Whiskers 实例完成清理。源码指纹为 `140e55da85c3b2bc7c91cf1b2369a09d40d8481af655bbd8b9a32bc0609bd166`。 [安装态验收](https://github.com/MaLaNg116/itervane/actions/runs/44996736228/job/137136561542) · [原生 Whiskers](https://github.com/MaLaNg116/itervane/actions/runs/44996736229)
