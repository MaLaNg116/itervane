# ADR 0003：门户使用标准 OIDC 客户端与同源 Bearer API

- 日期：2026-11-18；状态：P1-C 采用。

## 决定

门户复用 oidc-client-ts 的 Authorization Code + PKCE S256，首个 IdP 仍为 Keycloak。API 原有 JWT 验签、当前项目授权和外部 MCP 不改为另一套会话；浏览器不收集账号密码，也不粘贴 access token。

采用显式 InMemory userStore，access/refresh/ID token 不写 localStorage/sessionStorage/IndexedDB。登录事务所需 state/verifier 使用短暂 sessionStorage；回调处理后移除 URL 中的 code/state，清理过期交互记录。长期本地偏好只有 locale。

内存 token 意味着页面硬刷新后需重新登录，IdP 的 SSO 会话可以复用。首批选择清楚、可控的登录入口，不用隐藏 iframe 或持久 token 绕过此边界。刷新令牌若存在，经单次在途刷新调用续期；失败时清理身份/私有缓存并要求登录，不自动重放领域写命令。

登录/回调/注销错误使用本地资源键，服务器与浏览器都不输出原始授权响应。未知主体不自动登记为 owner；JWT 身份不证明人类批准。发布/运维批准保留后续独立协议。

## 理由与后续

这是对现有 Bearer API 的最小复用，避免 P1-C 同时引入 Cookie、服务端 token 存储、会话迁移、CSRF 和第二条 API 授权路径。BFF 并非排除项；如未来部署策略要求浏览器完全不接触 token，需另立 ADR 统一服务端会话、刷新并发、CSRF 和 MCP 的边界。

公开配置只含固定 issuer/client ID/回调 URL；不把运行配置整体序列化给浏览器。同源静态入口带 CSP，AntD 动态样式使用每次 HTML 响应的 nonce；所有任务文本通过 React 文本节点展示。

受信任 Keycloak 可与 PG 一样在临时容器中验证登录，未放宽对不可信源码的一次性虚拟机要求。具体部署模式、证据与未覆盖事项写入本批 guide。

参考：[OIDC 客户端设置](https://authts.github.io/oidc-client-ts/interfaces/UserManagerSettings.html)、[Keycloak JavaScript 安全接入](https://www.keycloak.org/securing-apps/javascript-adapter)、[Keycloak 容器](https://www.keycloak.org/server/containers)。
