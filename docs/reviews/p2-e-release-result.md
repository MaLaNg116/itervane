# P2-E-D3-C2 · 双语发布结果导读

接续 [独立发布 Worker #58](https://github.com/MaLaNg116/itervane/pull/58)。固定交付代码与用例 `7cfb133216d3f97b5b7d0d8b16e038e5753dd20f`。 [PR #59](https://github.com/MaLaNg116/itervane/pull/59) · [分批计划](../plans/p2-e-release-result.md)

1. `a03aa49` 在现有项目授权和任务锁内，按任务、运行和候选读取正式操作、Komodo 更新与最新核验尝试。只有匹配已结算证据的操作才能产生已验证摘要。排队、观察、阻断与转人工各有双语消息。门户发布接口与只读工具 `get_release_result` 共用同一投影。 [数据投影](https://github.com/MaLaNg116/itervane/blob/a03aa49/packages/control-plane/src/service/release-result.ts) · [MCP](https://github.com/MaLaNg116/itervane/blob/a03aa49/packages/control-plane/src/mcp.ts)
2. `403de7b` 在发布面板显示运行镜像、应用版本、实际更新标识和核验时间。人工核验显示脱敏原因。切换运行后通过任务版本校验移除旧结果。冻结证据与决定历史继续使用同一面板的键盘入口及 GSAP 减少动效处理。 [门户](https://github.com/MaLaNg116/itervane/blob/403de7b/packages/portal/src/pages/task-release.tsx)
3. `408b851` 在真实 PostgreSQL 中提交核验成功和转人工，使用 HTTP 与实际 MCP 客户端在两种语言下比对同一返回，并验证撤权后两边均拒绝。浏览器覆盖更新、语言切换、减少动效和当前运行隔离。 `aa10586` 补上 OAuth 回调完成后再创建测试任务的等待。 [HTTP 与 MCP](https://github.com/MaLaNg116/itervane/blob/408b851/packages/control-plane/test/integration/inspections.test.ts) · [浏览器](https://github.com/MaLaNg116/itervane/blob/aa10586/packages/portal/test/browser/portal.spec.ts)

TypeScript、202 项单元和两项真实 PostgreSQL 专项通过。真实 Chrome、Keycloak 与控制面会话跑通 3 项门户用例，`aa10586` 的浏览器报告源码指纹 `a96e2ad022062d4bccc15a0953a144db0f3e586e1d25a526ba4c44d3dc21b325`。浏览器用例以可控的发布响应覆盖状态切换，真实数据库验收核对实际结算行。首次全量遇到两道旧断言缺少新增的 `result: null`，`7cfb133` 已补明尚未发布的响应契约。全量复跑及托管证据随交付归档。

D3-D 在托管 KVM 上用同一操作验收外部 MCP 接入、修复和复验、人工确认、真实发布与受保护入口结果。
