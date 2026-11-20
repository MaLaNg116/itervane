# P1-UX 后续批次 · shadcn/ui 迁移导读

先读[实施计划](../plans/p1-ux-shadcn-migration.md)。本批以 [PR #7](https://github.com/MaLaNg116/itervane/pull/7) 的 `631525f08e7993035c5a4debabb5ae389a2bb7f8` 为比较基线。

## 任务详情验证

通过真实 OIDC 登录，登记测试仓库固定版本并提交模拟数据任务。Worker 创建检查计划并进入等待隔离 Runner 的状态。浏览器通过正式 API 读取任务记录、源码检查准备和过程记录，通过外部 MCP 对照同一任务和计划摘要。桌面并排显示过程记录与证据，窄屏按 DOM 顺序堆叠并保留精确版本、指纹和状态。

| 代码节点 | Review 要点 |
| --- | --- |
| [任务详情](https://github.com/MaLaNg116/itervane/blob/01b67a39560415ae1c89d12244d620d71227fcc4/packages/portal/src/pages/task.tsx) | `useRemote` 使用原查询和轮询；打开确认时捕获 expectedVersion，提交仍由原 API 校验。请求在途时阻止关闭和再次提交，角色降为只读时立即移除确认 |
| [浮层基础](https://github.com/MaLaNg116/itervane/blob/01b67a39560415ae1c89d12244d620d71227fcc4/packages/portal/src/ui/dialog.tsx) | 沿用 Base UI 的焦点和滚动控制，弹窗名称与说明来自双语消息。默认焦点在安全操作，Escape 回到触发按钮 |
| [动效](https://github.com/MaLaNg116/itervane/blob/01b67a39560415ae1c89d12244d620d71227fcc4/packages/portal/src/motion.tsx) | 继续以真实状态、序号和系统偏好驱动局部 GSAP，卸载清理样式 |
| [浏览器用例](https://github.com/MaLaNg116/itervane/blob/01b67a39560415ae1c89d12244d620d71227fcc4/packages/portal/test/browser/portal.spec.ts) | 375、768、1365px；中文和英文确认、焦点循环、Escape 零写入、真版本冲突后重确认、请求中禁用、权限降级和撤销 |

共存期快照 `73be63f11b9ad15ca0214c13e403231c30547197` 的 21 项真实浏览器用例、严格类型与 73 项单元通过。截图复核后修正未加载 Preflight 时卡片标题的边框宽度和原生控件字体优先级，`01b67a39560415ae1c89d12244d620d71227fcc4` 再次通过 5 项任务详情检查，源码指纹 `491ee045b587994a35611a59fe0051db3cf93be0229446c7e0222e0e8932970b`。CSP 检查在共存期仍只识别此前明确分类的 AntD 辅助样式，未为 shadcn 增加例外。

基线生产构建的哈希资源与 #7 一致，重跑的旧页面浏览器报告为 20/20。Windows 使用本机已经准备的 Itervane PostgreSQL 与 Keycloak 测试镜像；Linux CI 沿用仓库固定镜像。构建体积按 `dist/assets` 内各 JS/CSS 文件字节和 Node gzip level 9 之和计算。

| 构建 | JS 原始 / gzip（字节） | CSS 原始 / gzip（字节） |
| --- | ---: | ---: |
| #7 AntD 基线 | 1,377,502 / 444,644 | 9,791 / 2,777 |
| 详情页迁移，组件共存 | 1,446,435 / 466,808 | 21,744 / 5,036 |

并存导致总 gzip 增加约 5.5%。通过任务详情交互和安全验证后逐页迁移，完整替换后再与基线比较。体积包含所有延迟加载页面，用于比较交付资源，不能当作单页实际传输量或运行延迟。
