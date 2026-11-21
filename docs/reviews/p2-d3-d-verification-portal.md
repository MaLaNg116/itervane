# P2-D3-D-D2 · 门户复验与返修历史

基于 [复验查询 #37](https://github.com/MaLaNg116/itervane/pull/37)。任务详情展示当前候选的独立复验、源码对比、受保护检查与镜像摘要。有返修时，上一代候选的实际失败项可以展开查看。 [实施计划](../plans/p2-d3-d-verification-read-side.md)

1. `e6f28aa` 新增任务复验面板。请求以会话、语言和任务版本为查询键，利用任务详情已有的轮询刷新。收到的当前 run 必须与任务详情对应，避免把另一代结果显示在当前候选下。 [任务详情](https://github.com/MaLaNg116/itervane/blob/e6f28aa/packages/portal/src/pages/task.tsx) · [复验面板](https://github.com/MaLaNg116/itervane/blob/e6f28aa/packages/portal/src/pages/task-verification.tsx)
2. 当前状态沿用可读的实时提示。历史与摘要使用现有 GSAP `Disclosure`，支持键盘操作和动态减少动效。接口失败时清除面板中的证据并给出重试入口。 [查询键](https://github.com/MaLaNg116/itervane/blob/e6f28aa/packages/portal/src/context.tsx) · [双语文案](https://github.com/MaLaNg116/itervane/blob/e6f28aa/packages/portal/src/messages.ts)
3. `b141fe6` 使用真实 Chrome、Keycloak、PostgreSQL 和 Worker 驱动登录与任务面板。本用例在 HTTP 边界模拟两代查询的结果，检查版本递增触发刷新、503 历史、语言切换、错误恢复、键盘与减少动效。实际回执和成员权限由 [复验查询验收](p2-d3-d-verification-read.md) 覆盖。 [浏览器场景](https://github.com/MaLaNg116/itervane/blob/b141fe6/packages/portal/test/browser/portal.spec.ts)

本机 TypeScript 和该浏览器场景已通过，受测页面没有 CSP 违规。以 `629bb8f` 运行的 Linux CI 通过 Chrome、Keycloak、PostgreSQL 和 Worker 的全部 24 项浏览器场景，包含语言切换、任务版本、权限和已有动效。 [全量浏览器回归](https://github.com/MaLaNg116/itervane/actions/runs/44909983933/job/136863611546)

面板显示的证据为人工查看和核对使用。后续发布交给 P2-E 的审批流程。

核对最终提交 `47053c99b0f52e4cb06bc7a1cfba5ce5ea5bccfb` 的常规 CI 和相同浏览器源码后，以 `028a76a79865581330a6750a401fd00c5caf6115` 合入 `main`。 [合并记录](https://github.com/MaLaNg116/itervane/pull/38)
