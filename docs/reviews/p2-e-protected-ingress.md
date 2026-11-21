# P2-E-D2-A/B · 受保护入口与健康核验导读

基于 [Komodo 运行回读 #53](https://github.com/MaLaNg116/itervane/pull/53)。本批交付核验配置、只读验证和真实代理夹具。固定源码 `08e1a81381211990ab272007e0a6310bde3b3abf`。 [分批计划](../plans/p2-e-protected-ingress.md)

1. `3216d3a` 将 HTTPS 入口、私有网络、后端端口、管理读取通道和 Keycloak 应用探测身份规范化并计算指纹。现有登记事务校验指纹，同时沿用目标修订和审批失效语义。 [目标登记](https://github.com/MaLaNg116/itervane/blob/3216d3aa9ef5d510228007e5da32e675d9189769/packages/control-plane/src/service/release-targets.ts)
2. `dc9fb3b` 将实际容器名加入 Komodo 回读，核对自动映射宿主端口已关闭。代理的单一后端绑定这个容器名和登记端口。 [容器回读](https://github.com/MaLaNg116/itervane/blob/dc9fb3b/packages/control-plane/src/runtime/release-komodo.ts)
3. `3255671` 和 `e14bad9` 先核验 Traefik 的有效路由、后端与中间件，再验证匿名受阻和获授权的健康响应。普通应用请求只允许 Cookie 进入认证服务。探测凭证只在 `GET /health` 上生效，而且应用收到请求前已经移除认证头。核验完成后再次回读容器与有效路由。 [Traefik 核对](https://github.com/MaLaNg116/itervane/blob/e14bad9f1735ea50a3c44066ef87984a308be06e/packages/control-plane/src/runtime/release-traefik.ts) · [健康核验](https://github.com/MaLaNg116/itervane/blob/3255671503d25491e190bb5c49c65ac384214e9f/packages/control-plane/src/runtime/release-rollout.ts)
4. 原生夹具在临时 Keycloak、Traefik 3.7.18 和 OAuth2 Proxy 7.15.6 之间核对实际授权结果。使用临时 TLS 证书、固定代理摘要和 loopback 端口，清理全部本轮资源。托管工作流保存脱敏报告。 [夹具](https://github.com/MaLaNg116/itervane/blob/08e1a81381211990ab272007e0a6310bde3b3abf/fixtures/ingress/probe.mjs) · [托管核验](https://github.com/MaLaNg116/itervane/blob/08e1a81381211990ab272007e0a6310bde3b3abf/.github/workflows/native-ingress.yml)

TypeScript、200 项单元及发布目标修订的真实 PostgreSQL 专项通过。真实 TLS/Keycloak/Traefik 本机试验已核对匿名拒绝、正确角色健康、错误角色拒绝、凭证剥离、503 和鉴权失联。实测发现 Traefik 使用 `X-Next-Page: 1` 表示路由清单结束，验证器按固定版契约处理。固定托管夹具待验。 [Traefik 分页实现](https://github.com/traefik/traefik/blob/v3.7.18/pkg/api/criterion.go#L86)

本机试验的后端是可信样例，运行身份来自固定夹具。真实 Docker 私有网络的自托管接线及入口核验随 D2-C 验证，D3 接续正式发布操作、短租约和最终数据库结算。
