# P1-UX：门户设计与动效运行说明

- 日期：2026-11-20；[本批计划](plans/p1-ux-portal-design-motion.md)、[第三方参考与许可](third-party-ui.md)、[review 索引](reviews/README.md)。
- 这是 P1-E 上的独立体验切片，复用原有 React/AntD、OIDC、领域 API、MCP 和数据库。没有迁移、模型调用、Runner 接入或发布动作；capability stage 仍为 p1-e。

## 交付内容

门户采用统一语义 token、原创 SVG 品牌标记、深色导航和明亮内容区。项目目录以行组织，任务页突出当前状态、数据类别和任务语言；活动时间线只表达已经记录的事实，元数据保留精确 ID/hash 并支持换行。桌面长页面保持导航可达，窄屏使用流式布局；文案与组件继续支持 en/zh-CN。

设计实际参考了固定版本 UI UX Pro Max 和 frontend-design，来源及采纳/不采纳的理由写入计划。完整 Skill、Python 工具及检索缓存仅用于开发，不是产品运行依赖，也不代表实现了 P4 Skill 上传。

gsap@3.15.1 与 @gsap/react@2.1.2 精确锁定：

- 页面标题的装饰线轻量展开，页面内容始终默认可见。
- 任务状态确实改变时，只反馈装饰圆点，状态文字与操作立即更新。
- 时间线只对新记录的序号作局部反馈，最多 3 项；正常轮询和显示语言变化不重播旧记录。
- 原生 details 用于报告元数据，键盘语义与立即开关保留，打开时只作小幅 transform。

不使用 ScrollTrigger、滚动接管、退出保留层、私有 DOM 克隆、自动滚动、假进度或动画回调驱动 API 写入。

## 系统偏好、会话与 CSP

系统 prefers-reduced-motion 的初始值和运行中变化都会生效，减少模式跳过非必要 GSAP 动画、关闭 CSS 过渡，并清除正在运行的样式。减少偏好不写本地存储；登录/表单/报告状态不因偏好切换而重建。

AntD motion token 固定关闭。已锁定 AntD 6.7.1 在首次 true→false 时会增加 Motion Provider，导致子树重挂载；因此不把该主题 token 动态绑定媒体偏好。选定动效由局部 GSAP/CSS 管理，卸载/撤权/登出无需等待退场。

公共设计变量通过带当前 HTML nonce 的固定样式声明提供，AntD 渲染到 body 的弹窗也能使用。变量全是源码中的固定颜色，不拼接用户值；CSP 保持原 script/style/连接域白名单，不增加 unsafe-inline、unsafe-eval、CDN 或远程字体。

浏览器入口先启用 Zod jitless，再经异步模块边界装载应用，确保打包后也先配置策略、后构造共享 object schema。服务器校验配置不变，不为库的 JIT 探测放宽脚本策略。

既有 rc-component 辅助滚动条/滚动锁及 CSS 特性检测会尝试插入无 nonce 样式，仍被原 CSP 阻断。本批不修改该依赖，不将 CSP 总事件数声称为零，也不把被阻断的背景滚动锁样式当作已验收能力。浏览器测试只识别这些已知生成样式的具体形状，其他脚本或样式违规仍使检查失败。Modal 的键盘、关闭、版本确认和权限依旧经过实际回归。

## 升级与运行

沿用 P1-C 的 OIDC 与同源部署配置，没有新环境变量，也不增加业务数据库迁移：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:portal
# 停止原 API 后重新启动，使其重新载入构建资源白名单
pnpm start:api
```

Worker 无须因本批前端代码更改而迁移或启用新能力。不要在同一已启动 API 后台只覆盖 dist 并认为其内存资源映射已更新；正确流程是重建并重启 API。

构建生成 dist/third-party-licenses.md，发布包应保留；JS 保留第三方许可提示。该文件不被额外开放为任意静态路径。使用系统字体与同源 JS/CSS，不需要字体服务或 CDN；GSAP 保留其独立 Standard No Charge License，自有代码继续 Apache-2.0。

## 验证与限制

```sh
pnpm check
pnpm test:integration
pnpm test:portal
```

浏览器沿用临时、仅 loopback 的真实 Keycloak/PostgreSQL/API/Worker/Chrome，默认减少动效，新增用例显式启用正常动效并测试偏好切换。测试观察真实 DOM transform、真实任务取消和新增事件，不 mock 动画或服务端成功；已有隐私、撤权、幂等、旧版本确认及 API/MCP 一致性继续回归。

脱敏浏览器报告仍在忽略目录 .reports/p1-c/browser.json；本批截图在 .reports/p1-ux/。不记录 token、身份响应、预审原文、浏览器 trace 或登录页截图；失败诊断保留类别与源码位置。

本批不宣称全面可访问性认证、性能基准或完成 P1。构建仍提示较大的共享组件 chunk；目前只记录真实构建体积，没有承诺所有设备的帧率。三条闭环、五种角色、双向 MCP、执行并发、P2-A/P4 和真实 VM 验收边界不变。
