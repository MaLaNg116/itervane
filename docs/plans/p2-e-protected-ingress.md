# P2-E-D2 · 受保护入口与健康核验

从 [运行镜像回读 #53](https://github.com/MaLaNg116/itervane/pull/53) 接续。发布结算需要使用运行事实、实际入口和应用健康的同一份证据。应用身份授权独立于治理控制面。 [上线核验总计划](p2-e-rollout-verification.md) · [v6 蓝图](../blueprint-v6.md)

| 批次 | 工作 | 验收 |
| --- | --- | --- |
| D2-A 核验配置 | 安装维护者登记 HTTPS origin、固定健康路径、应用私有网络、当前服务端口、Traefik 的受限管理读取通道和入口定义、Keycloak 应用探测身份。按严格结构和规范顺序计算 `rolloutCheckSha256`，使用既有版本化目标登记事务。 | 相同配置重登保持版本，改入口或身份导致原登记和候选失效。拒绝摘要不符、混入凭证、Docker 默认网络和任意探测路径。缺少配置的旧目标仍可读取。 |
| D2-B 入口核验 | 回读运行容器和 Traefik 运行路由。以文件 provider 管理的 HTTPS Host 路由绑定登记容器在专属桥接网络中的 Docker 名称及端口。核对唯一后端、入口、访问中间件及去凭证配置。授权前后复查实际容器和路由。 | 其他容器即使健康也不能作为证据。匿名请求因认证被拒，短期应用身份对同一路径返回符合标准的健康响应，令牌仅送到登记 HTTPS origin，响应有时限与长度上限。禁用登录跟随和对应用转发 Cookie 或 Bearer。 |
| D2-C 自托管参考组合 | 使用 Traefik OSS 文件 provider、OAuth2 Proxy ForwardAuth 与 Keycloak 应用专用客户端/角色。运维侧只读查询 Traefik 管理 API，应用主机只暴露 HTTPS 入站。代理的应用私有网络仅接入代理和登记容器，认证通道独立。 | 真实 TLS、Keycloak 与 Traefik 验证健康、无授权、错误应用角色、错误后端、应用 503 和认证组件不可用。检查实际代理与应用隔离、入口和中间件配置，保留脱敏结果。 |

管理接口与业务入口由安装者在同一 Traefik 实例登记。文件配置显式声明业务 Host、OIDC 路径和 `GET /health` 三条规则，应用镜像标签不参与入口发现。普通应用路由只向认证服务发送 Cookie，健康路由还接受 Keycloak 签发给该应用的短期探测 Bearer。两条应用路由都在上游转发前清理认证凭证。密钥、证书私钥、Cookie、JWT、路由返回原文和应用返回原文均不进入发布证据。

受保护路径以 HTTP 401 或 403 证明匿名访问受阻。登录入口留给浏览器完成 OIDC 跳转；核验客户端从不跟随重定向。健康响应的版本文字用于业务展示，实际发布版本以 Komodo 回读镜像摘要为准。

只读检查在 D2 完成后具备实际下游证据。D3 负责领取有界核验权、存证明、整理双语状态和结算发布，再以真实获批 OCI 和源任务完成 P2 验收。

 [Traefik 文件配置](https://doc.traefik.io/traefik/reference/dynamic-configuration/file/) · [运行路由 API](https://doc.traefik.io/traefik/operations/api/) · [ForwardAuth](https://doc.traefik.io/traefik/reference/routing-configuration/http/middlewares/forwardauth/) · [OAuth2 Proxy 的 Keycloak 授权](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.6/docs/docs/configuration/providers/keycloak_oidc.md)
