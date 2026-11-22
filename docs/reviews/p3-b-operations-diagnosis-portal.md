# P3-B3d2 · 双语运维诊断门户 Review Guide

[草稿 #81](https://github.com/MaLaNg116/itervane/pull/81) 接续 [双语诊断查询 #80](https://github.com/MaLaNg116/itervane/pull/80)。页面和浏览器测试固定在 `a08809d767303ff9f27066c54589c1184839dae6`。 [实施计划](../plans/p3-b-operations-diagnosis-portal.md)

1. 看 `TaskOperations`。页面按当前任务 ID、run 和版本使用授权查询，诊断完整时显示建议、假设和引用证据。 [任务详情](https://github.com/MaLaNg116/itervane/blob/a08809d767303ff9f27066c54589c1184839dae6/packages/portal/src/pages/task-operations.tsx#L53)
2. 看 `DiagnosisDetails`。证据按类别展开。发布标识、采样计数和资源使用率用当前语言展示，摘要用于追溯结算。展开复用支持键盘和减少动效的 GSAP Disclosure。 [诊断证据](https://github.com/MaLaNg116/itervane/blob/a08809d767303ff9f27066c54589c1184839dae6/packages/portal/src/pages/task-operations.tsx#L91)
3. 看真实浏览器场景。保留 Keycloak 登录和当前任务授权，替换下游响应为确定性诊断材料，覆盖幂等重试、语言切换、键盘、减少动效、降权和撤权。 [浏览器用例](https://github.com/MaLaNg116/itervane/blob/a08809d767303ff9f27066c54589c1184839dae6/packages/portal/test/browser/portal.spec.ts#L502)

本机 TypeScript、223 项单元、Vite 构建及 Chrome 专项通过。浏览器使用 PostgreSQL 17.12 和本机缓存的 Keycloak 26.8.2。缓存的四个文件系统层、入口和运行用户已与官方固定清单核对。 [托管验收](https://github.com/MaLaNg116/itervane/actions/runs/44979250267)

B3d3 接续真实安装配置及正式任务的原生 Whiskers 验收。P3-C 处理运维动作审批与恢复验证。
