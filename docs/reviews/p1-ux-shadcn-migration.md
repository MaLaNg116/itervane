# P1-UX 后续批次 · shadcn/ui 迁移导读

先读[实施计划](../plans/p1-ux-shadcn-migration.md)。交付见 [PR #8](https://github.com/MaLaNg116/itervane/pull/8)及其 [Linux CI](https://github.com/MaLaNg116/itervane/pull/8/checks)，原比较基线为 [PR #7](https://github.com/MaLaNg116/itervane/pull/7) 的 `631525f08e7993035c5a4debabb5ae389a2bb7f8`。

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
| 迁移完成 | 670,230 / 215,772 | 23,134 / 5,428 |

并存期总 gzip 增加约 5.5%，替换完成后相对基线减少约 50.6%。统计包含所有延迟加载页面，衡量交付资源体积。单页加载时延需另行实测。

## 最终版本的代码阅读顺序

固定代码 `6405c01d0b7d1cd8d424e627847d8150bf5f865a`。先看任务详情通过前后的变更，再按下表看逐页迁移。

| 顺序 | 代码 | 审查重点 |
| --- | --- | --- |
| 1 | [组件源码](https://github.com/MaLaNg116/itervane/tree/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/ui)、[色板和布局](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/style.css) | 样式在构建期生成，组件复用现有色板和语义。任务状态、活动、源码检查在不同区域呈现同一份服务端事实 |
| 2 | [任务详情](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/pages/task.tsx) | 真正的版本冲突返回后必须重新打开确认。正常关闭和请求中按 Escape 各有路径，撤销写权限由原权限轮询收起确认 |
| 3 | [表单共用逻辑](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/forms.tsx)、[项目列表](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/pages/projects.tsx)、[项目详情](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/pages/project.tsx) | 输入在浏览器表单里，通过共享契约转换。错误关联到字段，焦点定位到第一处错误。提交进入等待后使用原输入和幂等键重试 |
| 4 | [规则与预审](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/pages/preaudit.tsx)、[查询边界](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/context.tsx)、[报告](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/pages/preaudit-report.tsx) | 只有同资源同会话的语言切换可沿用摘要。预审原文留在表单/请求内存，缓存的是脱敏报告。断开和撤权仍走原失效路径 |
| 5 | [壳层](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/src/app.tsx)、[构建](https://github.com/MaLaNg116/itervane/blob/6405c01d0b7d1cd8d424e627847d8150bf5f865a/packages/portal/vite.config.ts) | Base UI 读取同一 HTML nonce。登录、登出、权限错误与深链接沿用原状态和入口。移除 AntD、cssinjs 及其辅助样式测试例外 |

## 验收记录

- 项目列表与详情迁移后 6/6 项真实流程通过，覆盖创建、登记、响应丢失重试、实际撤权和键盘。预审与报告迁移后 8/8 项通过，覆盖中英文、输入字节限制、语言切换保留重试、报告隐私和减少动效。
- 最终快照的冻结锁安装、生产构建、严格类型、73 项单元、66 项 PostgreSQL 17.12 集成和 21 项真实浏览器均通过。浏览器与数据库的源码指纹均为 `31c043fdbf6722a7e86342d785d08ef35f199cae7526e024467bc7513678229d`。
- Chrome 中观察到的 CSP 违规在已覆盖路径为零，检查包含登录后的任务生命周期、确认浮层、项目表单、报告以及撤权后的受保护内容消失。浏览器验证覆盖 Chromium 路线，其他浏览器和辅助技术仍是独立验收项。
- Windows 的任务及表单截图在忽略目录 `.reports/p1-c/`、`.reports/p1-shadcn/` 和 `.reports/p1-ux/`。PR 的测试日志只保留脱敏结果。构建已验证复制原始 shadcn MIT 许可，部署与回退见[运行说明](../portal-shadcn.md)。

本批完成 M12 门户迁移。平台目前仍处于 P1-E 能力范围，真实 VM 执行、部署运维、P2-A Agent 循环和 P4 规则生命周期各按 [v6](../blueprint-v6.md) 与对应计划验收。
