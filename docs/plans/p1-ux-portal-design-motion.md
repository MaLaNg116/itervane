# P1-UX：门户设计与动效增强

- 日期：2026-11-20；状态：计划先行已提交，U0—U4 本地交付通过；U5 文档与叠加草稿 PR 交付中，远端证据随后记录。
- 前置：P1-E / [草稿 PR #6](https://github.com/MaLaNg116/itervane/pull/6)，基线 `2390bb3629f5567e90093fb3a737794b3bfdbb10`。使用 `feat/portal-design-motion`，PR 比较基线指向 `feat/p1-rules-preaudit`，不合并前置 PR。
- 依据：v6、TS + PostgreSQL 实施计划、ADR 0001/0003/0005；独立体验切片，不新增 P2/P3/P4 能力，不代表完整 P1 验收。

## 1. 使用的设计参考与核对

本批实际读取并应用两份 Skill，固定内容版本，供以后复核：

- [UI UX Pro Max / SKILL.md](https://github.com/nextlevelbuilder/ui-ux-pro-max-skill/blob/2de1134dc4d1cfe112934611ae5803ae17a1bd7e/.claude/skills/ui-ux-pro-max/SKILL.md)：采用产品匹配、语义 token、可读性、响应式、键盘与减少动态效果方法；读取 web quick-reference，native pro-rules 仅作适用性核对。
- [frontend-design / SKILL.md](https://github.com/anthropics/skills/blob/e4bb5d960d87126ff3b3a8af1a104b7db67560ba/skills/frontend-design/SKILL.md)：先明确产品和视觉方案，再实现、截图复核；让品牌和真实任务内容决定视觉层级。

UI UX Pro Max 在忽略缓存中运行本地检索，无私人输入：初次 `developer tool dashboard evidence` 错配 FAQ，未采纳；按 Skill 重试一次 `operations monitoring dashboard` 匹配运维场景。后者仍带 landing/glass 推荐，因此只采纳可核实的阅读密度、语义状态和真实来源原则；不照搬营销结构、玻璃背景、全黑主内容或虚构指标。另检索 reduced motion、GSAP 微反馈和 React effect cleanup，均有对应结果。未将原始生成输出直接写入产品。

Skill 是本次开发的方法参考，不是平台内上传的规则包或已经实现的 P4 功能；缓存和第三方完整 Skill 不提交仓库，不全局安装。

## 2. 视觉方案与设计自审

使用者是维护者与项目成员，主要任务是判断当前状态、阅读证据、发起受控操作。选择“深色导航 + 明亮内容 + 清晰状态轨迹”的工程工作台。

| 基础颜色 | 值 | 用途 |
|---|---|---|
| ink | #102A43 | 导航底色、主文字 |
| brand | #126D74 | 主操作、焦点与品牌线条 |
| canvas | #F4F7FA | 内容背景 |
| surface | #FFFFFF | 内容面板 |
| muted | #526574 | 辅助文字 |
| border | #D9E2EC | 分组与结构边界 |

状态另外使用独立 success/warning/error/info token，并以文字共同表达。样式 token 与 AntD 主题统一维护。字体使用系统 sans-serif 与中文系统字体，标题以尺度和字重建立层级；真实 ID/commit/hash 使用等宽字体。本批不新增远程字体、图片或字体静态路由，保持现有 CSP 和自托管资源边界。

间距采用 4/8 基础节奏；正文左对齐，长说明限制阅读宽度，ID 可换行。面板按重要性使用不同层级，不给每段文字套同样的卡片。品牌标记使用本项目原创 SVG，避免 emoji 图标和泛用斜体字母。

```text
品牌 / 工作区                                      语言
┌ 导航 ──────┬ 当前页面标题                即时操作 ┐
│ 项目       │ 任务当前状态 / 已登记源码 / 执行限制 │
│            │ 核心内容                证据与元数据 │
│ 当前账号   │ 平台活动记录（仅新增标记轻量反馈）   │
│ 退出登录   │                                      │
└────────────┴──────────────────────────────────────┘
```

比较过“继续铺满等大卡片”的方案，其信息层级不足，因此改为有主次的内容分组；不引入营销 hero、假统计或未来功能入口。最突出的元素是任务状态和活动轨迹，配色/排版服务于阅读。375px 下导航改为紧凑流式布局，中文/英文长文本均能换行，保留表格内部滚动。

## 3. 动效契约

采用精确锁定 `gsap@3.15.1` 与 `@gsap/react@2.1.2`，官方 useGSAP/context 管理生命周期。只使用 core/CSS transform，不引入 ScrollTrigger、滚动接管、动画编辑器或另一个动画框架。

| 场景 | 表现 | 不改变的含义 |
|---|---|---|
| 页面首次进入 | 标题/品牌装饰线约 240—280ms 的小幅 transform | 页面内容默认可见；无 exit/presence、无等待动画才挂载 |
| 任务状态实际变化 | 独立装饰标记约 280ms 的反馈 | 状态文字、取消/重试、错误/批准信息立即更新；不推断进度百分比 |
| 时间线新增记录 | 只反馈新增序号标记，限制单批数量 | 已有记录不随轮询/显示语言重播；不自动滚动或抢焦点 |
| 元数据展开 | 原生 details 立即展开，内容轻量 transform | 键盘/展开语义保留；关闭立即生效，不延迟删除/撤权 |

系统 `prefers-reduced-motion` 初始与运行中变化都受尊重，关闭 GSAP 非必要动画及 CSS 过渡。AntD motion token 固定关闭，由局部 GSAP/CSS 负责选定反馈；不动态切换主题 motion，因为已锁定 AntD 6.7.1 会在首次 true→false 时插入 provider 并重挂载会话/表单。JS/CSS 动效目标是装饰元素或非关键内容；没有默认 opacity:0 的私有页面，没有克隆 DOM、退出保留层、计时器驱动假状态或动效触发的 API 写命令。Effect、媒体监听和 tween 在卸载/目标变化时清理。

GSAP 与 @gsap/react 保留自身 Standard No Charge License，不称作 Apache-2.0 代码；在第三方说明登记精确版本与官方许可链接。Itervane 自有代码继续 Apache-2.0。本次用途是门户展示，不增加可视化动画编辑功能。

## 4. 不变量

- OIDC PKCE、内存 token、当前项目 read/write、MCP audience/scope、幂等键、预期版本确认保持；不新增身份/数据库迁移或 API 端点。
- 权限拒绝、登出、会话失效、API 错误及 Runner 不可用立即呈现；旧私人 DOM 不等待退场动画。
- 预审原文不进入动画状态、data 属性、日志、query key、mutation variables 或浏览器持久化；继续组件/ref/request 内存路径。
- 继续只读内置规则、advisory 预审、formalScan/releaseEligible=false；Runner/源码执行/部署/运维闸门全部保持现状。
- 保留三条闭环、五种角色、双向 MCP、单维护者/工作区/执行工作流；不把视觉状态当作批准或真实下游成功。

## 5. 按需求点实施与验收

| 单元 | 工作 | 依赖与验收 |
|---|---|---|
| U0 | 本计划、固定 Skill 参考、视觉方案和边界 | 首个独立文档提交 |
| U1 | 语义 token、品牌/壳层、页面/表格/表单层级和双语文案 | 复用 AntD；375/768/1365px 无页面溢出，长文本可读，焦点可见 |
| U2 | 固定依赖、可清理 GSAP primitives、动态减少动效 | 无 CSP 放宽/远程资产；StrictMode 和卸载无残留；默认内容可见 |
| U3 | 任务状态/新增事件、规则与报告元数据展开，双语场景接入 | 真正状态来自同一 API；轮询不重播，旧视图无退出保留；版本确认与幂等不变 |
| U4 | 真实 OIDC/PG/Chrome 正常及减少动效、键盘与隐私回归 | 运行已有 15 浏览器用例，补充必要的动效、媒体偏好切换、轮询稳定、展开、导航/撤权与窄屏验证；截图逐页复核 |
| U5 | 运行/第三方说明、固定代码 guide、索引、叠加草稿 PR | 分项中文 Conventional Commits；类型/单元、真 PG、浏览器和三组 Linux CI；完整阶段仍未验收 |

依赖 U0 → U1/U2 → U3 → U4 → U5；实现保持可逐需求 review。测试聚焦生命周期/权限/真实交互，不为配色和 CSS 值编写镜像断言。既有 73 单元、66 真 PG、15 浏览器与 5 可信扫描器基线保留；按实际结果记录新增数量，不靠截图或模型自报完成验收。

参考：[GSAP React](https://gsap.com/resources/React/)、[GSAP matchMedia](https://gsap.com/docs/v3/GSAP/gsap.matchMedia%28%29/)、[独立许可](https://gsap.com/community/standard-license/)。

本地 strict types、73 单元、66 真 PG、20 真浏览器及生产构建通过；截图整理后 5 项新增浏览器用例再次通过。固定代码 `cd300546c0cb7f902b745989e2854e0fb598dfd8`，最终截图复验的源码指纹为 `d9594627846bc6276602b4dd97f0334e48f2766629102049431b324688b673d9`。运行/升级见[运行说明](../portal-design-motion.md)，关键设计和对应代码见[review guide](../reviews/p1-ux-portal-design-motion.md)。
