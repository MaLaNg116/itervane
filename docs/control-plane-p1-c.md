# P1-C：最小门户、登录与中英文

- 日期：2026-11-18；范围见 [P1-C 计划](plans/p1-c-portal-and-login.md)，登录决定见 [ADR 0003](decisions/0003-browser-oidc.md)。
- 安装与数据库权限沿用 [P1-A](control-plane-p1-a.md)、[P1-B](control-plane-p1-b.md)；本批没有新业务迁移。
- 固定代码、验证和阅读路径见 [本批 review guide](reviews/p1-c-portal-login.md)。完整 P1 与 MVP 仍未验收。

本文保留 P1-C 的历史交付范围；后续新增迁移 0005 和源码检查准备卡片见 [P1-D1](control-plane-p1-d.md)。下文“没有新业务迁移”仅指 P1-C。

## 1. 能完成什么

`打开工作台 → 选择中英文 → 真实 IdP 登录 → 当前领域权限校验 → 创建项目 → 登记 HTTPS 仓库 → 提交固定 Git 版本 → 查看持久化任务/事件 → 重试前置检查或取消 → 注销`

React 门户复用既有 API、TaskService 和 Worker，不再建立一份前端任务状态机。门户提交的任务可由外部 MCP 查询同一 ID；刷新、退出或关闭页面不删除服务端任务。没有经过验证的隔离 Runner 时，任务准确停在 `waiting_input / runner_unavailable`。

本批只提供项目、仓库和任务页面。应用/环境编辑、成员管理、差异、批准、发布、运维和规则包页面仍按后续批次实现。浏览器认证不代表人类批准，重试前置检查也不授予执行源码或部署的资格。

## 2. 启动

需要 Node.js 24、pnpm 11.9.0、PostgreSQL 17 和维护者管理的 Keycloak。先按 P1-A/P1-B 完成专用平台库迁移、低权限运行角色和明确的 owner bootstrap，再配置：

| 配置 | 内容 |
|---|---|
| `DATABASE_URL` | 同一平台库的低权限运行角色；API 与 Worker 均使用 |
| `ITERVANE_OIDC_ISSUER` | 精确 realm issuer；API 继续使用该 realm 的固定 Keycloak JWKS 地址 |
| `ITERVANE_OIDC_AUDIENCE` | API audience，例如 `itervane-api` |
| `ITERVANE_PUBLIC_URL` | 浏览器实际访问的根 origin，例如 `https://itervane.example`；回调不从请求头生成 |
| `ITERVANE_PORTAL_CLIENT_ID` | Keycloak public client，例如 `itervane-portal`；留空关闭浏览器登录 |
| `ITERVANE_API_HOST` / `ITERVANE_API_PORT` | API 监听地址，默认 `127.0.0.1:4310` |

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:portal
pnpm start:api
```

另一终端运行 `pnpm start:worker`。API 在启动时加载可信的 `packages/portal/dist`，构建变更后需要重启 API。没有 dist 时 API/MCP 仍可运行，`capabilities.portal` 为 false；没有 public client 时门户显示配置提示，不开放匿名领域访问。首次安装仍需 `pnpm db:migrate` 和维护者执行的 `pnpm bootstrap:owner`，API 不自动迁移或登记管理员。

本批不提供独立 Vite 开发服务器认证代理。构建后的门户与 `/v1` 由同一 API origin 提供，生产入口可由维护者配置 TLS 反向代理；不要将测试身份服务的 `start-dev` 当作生产部署方式。固定公开 origin、代理日志脱敏、HTTPS/证书、真实域名回调与可用性仍需部署环境验收。

## 3. Keycloak 客户端核对

门户是标准 Authorization Code + PKCE S256 public client，浏览器和仓库均不需要 client secret，也不接收用户密码。

1. 为选定 realm 创建 OIDC public client，开启 Standard Flow，要求 PKCE S256；关闭 Direct Access Grants 和不需要的其他授权方式。
2. 精确登记 `<ITERVANE_PUBLIC_URL>/auth/callback` 和注销返回地址 `<ITERVANE_PUBLIC_URL>/auth/logout-callback`，不用任意通配回调。
3. Web Origins 只允许该公开 origin，使浏览器能够访问该可信 issuer 的发现、token 和 logout 端点。
4. access token 使用 RS256、JWT header type 和 `typ: Bearer`，包含 `iss/sub/iat/exp`，通过 audience mapper 加入 API audience。不要把 ID token 或 refresh token 当作 API 凭证。
5. 保留默认 `basic` client scope 中的 Subject mapper。Keycloak 25+ 将 access token 的 `sub` 放到此 mapper；自定义 realm 导入不能遗漏它。实际联调发现过这一配置问题，修正 IdP 后通过，后端没有放宽 required claims。
6. 选择确定的维护者 `issuer/sub`，由本机 bootstrap 命令登记。后续登录的未登记主体返回 403，不成为 owner。成员管理尚未提供公开写入界面。

浏览器只请求 `openid`，展示名优先使用已有的 `preferred_username`，否则显示 subject。若需要友好的展示名，可由维护者在该 public client 的默认映射中提供它；平台授权始终使用 issuer/sub。

API token 与 MCP token 分开配置：MCP audience 仍为公开 origin 加 `/mcp`，查询需要 `itervane:read`，写工具另需 `itervane:write`。本批通过真实 Keycloak token 和官方 MCP SDK 核对同一任务，但没有实现外部编码助手的完整浏览器 OAuth 客户端注册流程。测试专用 MCP 客户端的 password grant 仅在临时测试 realm 使用，不是生产接入建议。

参考：[Keycloak Subject mapper](https://www.keycloak.org/admin-api/protocol-mappers)、[Keycloak 客户端与浏览器安全说明](https://www.keycloak.org/securing-apps/javascript-adapter)。

## 4. 会话与静态资源边界

- access/refresh/ID token 只驻留内存；登录事务 state/verifier 短暂放在 sessionStorage，SDK 消费后清理。localStorage 仅保存语言偏好。
- 页面硬刷新丢弃凭证，需显式重新登录；IdP 仍有 SSO 会话时可以直接回到原来的合法本地页面。注销和身份失效清空私人查询缓存，过期会话不自动重放写命令。
- 有 refresh token 时只允许一个在途刷新；没有 refresh token 或刷新失败则要求重新登录。调用使用同源 Bearer、超时和会话代次校验，响应解析结束后也重新核对代次。
- 回调查询参数在 SDK 处理前从地址栏移除；API 应用日志只记录路由模板、requestId、机器码及状态，不记录 query、请求体或凭证。反向代理也应排除回调查询串和 Authorization。
- 同源服务只暴露三个 HTML 入口、构建资源白名单和 favicon；没有吞掉 API/MCP 路径的 SPA catch-all。HTML 使用每次响应的新 CSP nonce、no-store 和 no-referrer；AntD 动态样式使用同一 nonce。可信带哈希资源可长缓存，不公开源码、`.env`、报告或任务工作区。
- 用户输入通过 React 文本节点展示；无 Markdown/HTML 注入、脚本插件、宿主 shell 或 Docker socket。

持有浏览器内存 token 仍意味着同源脚本是信任边界。未来如需浏览器完全不接触 token，可另立 ADR 引入 BFF/CSRF 等完整会话设计，不与本批并存另一套未经验证的身份路径。

## 5. 操作与语言

| 行为 | 本批语义 |
|---|---|
| 创建项目 | 仅 workspace owner；项目当前角色与可写性由数据库返回 |
| 登记仓库 | owner/maintainer；仅 HTTPS 无凭证 URL，此时不拉取源码 |
| 提交任务 | 完整 40/64 位小写 Git ID、模拟/公开数据、明确任务 locale |
| 请求结果不确定 | 保留同一请求体和 idempotencyKey，显式重试；领域服务返回原任务 |
| 取消/重试 | 弹窗绑定打开时的 expectedVersion；409 后刷新状态，须再次确认 |
| 重试 preflight | 重用既有 run、剩余预算和最多三次人工重试限制；仍受 Runner 闸门约束 |
| 撤销权限 | 服务端每次检查；当前项目/任务轮询失败后隐藏私有内容；不是主动推送或已见数据的远程擦除 |
| 展示语言 | en / zh-CN，覆盖页面、AntD 组件、验证、状态、错误、事件和日期 |
| 任务语言 | 提交时持久化；切换显示语言不会修改已创建任务的 locale |

查询只在前台轮询，每次最多 100 条，尚无 cursor 分页；按钮可见性用于交互，服务端才是授权边界。变更命令不会自动重试。任务目的、Git ID、状态机器码和用户输入不翻译。

## 6. 验证

```sh
pnpm check
pnpm test:integration
# Linux 首次需要；Windows 默认使用本机 Chrome
pnpm --filter @itervane/portal exec playwright install --with-deps chromium
pnpm test:portal
pnpm probe:mcp
pnpm probe:evaluation
```

`test:portal` 先构建门户，再启动真实 API/Worker、真实 Keycloak 和 PostgreSQL 17。数据库测试与浏览器测试共用带随机标签、loopback 绑定和归属校验清理的 PostgreSQL 基础夹具；每个测试库仍有独立低权限角色。现有 `DATABASE_URL` 只可指向明确的专用测试库，不能指向生产库。

Windows 默认本机 Chrome，普通 Linux 默认 Playwright Chromium；配置 `ITERVANE_BROWSER_CHANNEL=chrome` 可显式使用已安装 Chrome。CI 在 Ubuntu 24.04 上使用预装 Chrome 并输出其版本，避免重复安装系统库导致的阻塞；用例和真实验收要求保持一致。

Keycloak 26.8.2 和 PG17 默认使用 `.env.example` 中的官方不可变镜像 digest。`ITERVANE_KEYCLOAK_IMAGE` / `ITERVANE_POSTGRES_IMAGE` 仅供维护者指定已校验的本机镜像；不降低 TLS 校验或包管理器的发布时间门槛。测试身份、密码、realm 和数据库均临时随机生成；Docker 只运行可信基础组件，不运行提交项目。

浏览器覆盖两种语言完整流程、真实 PKCE、严格身份声明、未知主体拒绝、角色变化/撤权、响应丢失后的幂等重试、真实版本冲突、内存凭证、硬刷新重新登录、单次在途刷新/IdP 撤销，以及窄屏中文表单。短 token 生命周期仅用于加速测试刷新路径。

`.reports/p1-c/browser.json` 记录源码指纹、静态用例名和通过/失败，失败只给出类别与代码位置。应用截图只保存在忽略目录；不记录 IdP 登录页截图，不启用包含凭证的 trace/video。报告不提交凭证、模型配置或私人主机信息。

本批没有调用模型、连接私人云机、执行不可信代码或验证公网生产部署。当前构建仍有 AntD 公共 chunk 超过 Vite 的 500 kB 提示，保留提示并记录，后续按真实加载指标优化，不以调高阈值消除告警。后续剩余 P1 工作以计划矩阵为准。
