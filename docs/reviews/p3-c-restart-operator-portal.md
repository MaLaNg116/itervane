# P3-C2c3c2b2 · 双语重启门户导读

依赖 #102，固定代码和测试为 `eaa0bfaeeadeee1aae209b49dc69a909a93de0a5`。 [PR #103](https://github.com/MaLaNg116/itervane/pull/103) · [分批计划](../plans/p3-c-restart-operator.md)

1. `9459568` 在授权的运维提案下读取重启回执。排队确认绑定提案、指纹和批准版本，续发确认绑定当前执行任务版本、原生批准编号和调用指纹。授权或绑定变化时关闭失效确认。连接失败可在有效确认中使用原幂等键重试。 [提案接入](https://github.com/MaLaNg116/itervane/blob/eaa0bfaeeadeee1aae209b49dc69a909a93de0a5/packages/portal/src/pages/task-operations-proposal.tsx) · [确认与请求](https://github.com/MaLaNg116/itervane/blob/eaa0bfaeeadeee1aae209b49dc69a909a93de0a5/packages/portal/src/pages/task-operations-restart.tsx#L28)
2. 回执显示等待、过期、核对或已恢复状态，以及原生批准编号。GSAP 展开区提供执行与发布编号、环境占用和恢复摘要，沿用减少动态效果偏好。 [回执和确认弹窗](https://github.com/MaLaNg116/itervane/blob/eaa0bfaeeadeee1aae209b49dc69a909a93de0a5/packages/portal/src/pages/task-operations-restart.tsx) · [文案](https://github.com/MaLaNg116/itervane/blob/eaa0bfaeeadeee1aae209b49dc69a909a93de0a5/packages/portal/src/messages.ts)
3. `eaa0bfa` 使用 Chrome、真实 Keycloak 登录和 PostgreSQL 任务权限，验证两种语言、取消确认、授权变化后的关闭、续发重试请求一致及恢复与过期回执。验证键盘展开、GSAP 动效与减少动效。浏览器中的部分运维响应使用受控夹具。 [浏览器专项](https://github.com/MaLaNg116/itervane/blob/eaa0bfaeeadeee1aae209b49dc69a909a93de0a5/packages/portal/test/browser/portal.spec.ts#L744)

TypeScript、246 项单元与 Vite 生产构建通过。新增重启场景和既有双语运维诊断场景均通过。新增场景报告指纹为 `877cc6f6cd3e17aacea48112f670aaf4751053ca382b8c370809721e88f2adb0`。实际 Whiskers 批准、专用 Worker 和同一应用独立恢复由下一批联验。 [托管检查](https://github.com/MaLaNg116/itervane/pull/103/checks)
