# P4-C3b · 双语规则库与人审门户

接续 [#144](https://github.com/MaLaNg116/itervane/pull/144)。规则库与文件导入固定于 `3b4c317e033e23ba424e1c85af009ac34d3121d9`，审核和激活界面固定于 `15d1f43ea40cfb7de2972ae4c5b2c0eaf8965c4c`。 [实施计划](../plans/p4-rule-package-portal.md)

1. 所有者通过规则库选择版本，上传 `SKILL.md`、参考文档和 JSON 设计资料。表单和控制面使用同一版本契约，附件内容以文本预览，沿用 shadcn/ui 和 GSAP 减少动效。 [版本列表与预览](https://github.com/MaLaNg116/itervane/blob/3b4c317e033e23ba424e1c85af009ac34d3121d9/packages/portal/src/pages/rule-library.tsx) · [导入](https://github.com/MaLaNg116/itervane/blob/3b4c317e033e23ba424e1c85af009ac34d3121d9/packages/portal/src/pages/rule-import.tsx)
2. 审核绑定版本指纹。激活确认冻结动作、版本、审核摘要、当前序号和幂等键。未知响应保留同一次请求，确定的冲突刷新状态。所有者授权撤回时退出私有页面。 [人工操作](https://github.com/MaLaNg116/itervane/blob/15d1f43ea40cfb7de2972ae4c5b2c0eaf8965c4c/packages/portal/src/pages/rule-package-review.tsx)
3. 任务详情显示提炼结果、三类样例和验证摘要。项目写权可入队验证，所有者可从通过的回执创建草稿。两个外部 MCP 工具使用与 HTTP 相同的项目读取授权和双语结果。 [门户任务](https://github.com/MaLaNg116/itervane/blob/3ddd45e71ea88d3cf066c3df7f8177a7956653c5/packages/portal/src/pages/task-learning.tsx) · [MCP 接入](https://github.com/MaLaNg116/itervane/blob/4c6eeea05f56474b2fcb8ed5f1ec8480671b2a50/packages/control-plane/src/mcp.ts)

TypeScript、7 项外部 MCP 真库回归和 2 项浏览器用例通过。Chrome 使用 Keycloak 26.8.2 与 PostgreSQL 17.12，双语测试包含文件导入、审核、版本历史、响应丢失重试、撤权与窄屏。规则文件是合成测试材料。生成候选的模型、实际来源和 Runner 验收范围见前置 C3a。 [浏览器用例](https://github.com/MaLaNg116/itervane/blob/fb28f386808312d6f424376fb566762a56c55d5d/packages/portal/test/browser/portal.spec.ts#L1615) · [托管检查](https://github.com/MaLaNg116/itervane/pull/145/checks)
