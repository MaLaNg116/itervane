# P1-UX 后续批次 · shadcn/ui 验证与逐页迁移

日期 2026-11-20。基于 [P1-UX 草稿 PR #7](https://github.com/MaLaNg116/itervane/pull/7) 的 `631525f08e7993035c5a4debabb5ae389a2bb7f8`，沿用[蓝图 v6](../blueprint-v6.md)、[TS + PostgreSQL 计划](../implementation-plan-v2-ts-postgresql.md)及 [ADR 0001](../decisions/0001-development-and-runtime-gates.md)、[ADR 0003](../decisions/0003-browser-oidc.md)、[ADR 0005](../decisions/0005-limited-text-preaudit.md)。

## 要验证的设计

任务详情是未来 Agent 工作台的入口。先用正式任务路由 `#/tasks/:id` 验证真实状态、处理记录、源码检查证据和人工确认如何组合。用现有 API 创建模拟数据任务，由真实 Worker 推进到 Runner 未就绪状态。保留后端给出的版本、状态、事件和覆盖限制，界面只呈现已取得的事实。

使用 shadcn/ui 的 Base UI 源码组件，按需引入 Button、Badge、Card、Alert 和 Dialog 等。将固定来源、原许可与本地修改记录纳入仓库。Tailwind CSS 由 Vite 编译为同源静态样式，沿用项目已有色板，不引入 Preflight 全局重置。Base UI 的运行时样式使用现有页面 nonce。[shadcn/ui Vite 文档](https://ui.shadcn.com/docs/installation/vite)、[Base UI CSP Provider](https://base-ui.com/react/utils/csp-provider)

现有页面字段数量少，采用原生表单、选择框和语义表格，复用共享 Zod 契约、React Query 和双语消息。字段错误跟随显示语言，已填写值和已发起的提交保持在原有生命周期内。等出现复杂表格需求时再评估 TanStack Table。

## 提交与验收顺序

| 阶段 | 交付 | 验收 |
| --- | --- | --- |
| 1. 记录基线 | 先提交本计划，再在现有实现记录生产构建和真实任务路径的测试结果及截图 | 同一测试栈、真实 OIDC、真实 PostgreSQL、Worker 和 Chrome，记录可比较的 JS/CSS 构建体积 |
| 2. 详情页验证 | 锁定依赖和源码来源；迁移任务详情，给记录与侧栏各自留出空间；保留局部 GSAP | 双语及 375、768、1365px 布局；键盘打开、聚焦、关闭和返回；版本冲突重确认、提交中防重复、撤权；系统减少动效实时生效；CSP 沿用现有策略 |
| 3. 逐页迁移 | 项目列表与创建 → 项目详情与仓库/任务表单 → 预审报告 → 规则与有限预审 → 导航和登录壳层 | 按页面提交并回归。重复项提炼小组件，保留表单值、服务端限制、提交幂等、报告隐私及中英文。第 2 阶段通过后才开始 |
| 4. 收尾交付 | 删除旧组件依赖、兼容样式和测试例外；更新选型与运行说明；保存固定 commit 的中文 review guide 并更新索引 | 严格类型、单元、真实 PG、全门户浏览器及 CI。最终重点路径零 CSP 违规，构建产物与迁移前按相同口径比较，记录局限与回退点 |

详情页验收要求真实前置检查、显式确认后的取消或重试、最新事件及相同版本冲突。弹窗默认定位到安全操作，关闭不调用写入接口。读者不可执行控制，从可写降为只读时收起已打开的确认。项目撤权或会话结束后移除受保护内容。减少动效与轮询、语言切换的检查沿用 P1-UX，验证装饰动画和当前任务状态各自的行为。

临时共存期间仅接受原测试已记录的 AntD 辅助样式类别，新增违规必须排查。若详情页未达到交互或安全要求，先修正并重测该页。逐页迁移完毕后移除 AntD，避免两套主题和表单长期共存。记录共存期和最终体积，构建体积用于比较加载成本，不据此推定交互延迟。

## 与 v6 的对应

本批变更位于门户 M01 展示与交互。OIDC PKCE、内存会话、API/MCP 权限、expectedVersion、幂等、用户申请与人类审批的区分均沿用现有领域逻辑。仍保持三个闭环、五种逻辑角色、双向 MCP 以及单个执行中业务工作流的设计。

capability 保持 `p1-e`。P2-A 的自主审计、修复与复验，P4 的 Skill 上传、规则发布与沉淀，以及隔离 Runner 的执行验收各有自己的计划。浏览器中的任务只运行当前受控 preflight，真实权限和策略结果可由 API/MCP 对照。

交付在 `feat/portal-shadcn` 使用叠加草稿 PR，比较基线为 #7 的 `feat/portal-design-motion`。各需求点采用独立中文 Conventional Commit。回退可重新构建 #7 快照并重启 API，没有数据迁移。
