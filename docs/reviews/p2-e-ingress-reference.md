# P2-E-D2-C · 自托管受保护入口导读

接续 [入口核验 #54](https://github.com/MaLaNg116/itervane/pull/54)。本批提供可复用的 Compose 接线、维护者配置与网络隔离验收。固定源码 `8c151baff3b06f004eb2b256d72e71a8a9c10ede`。 [计划](../plans/p2-e-ingress-reference.md)

1. `8b419bd` 提供三个用途不同的网络。应用加入维护者创建的内部网。OAuth2 Proxy 只使用认证网。业务 Traefik 从管理网卡提供只读 API，由该网的回环网关转发给宿主。使用同一固定 Traefik 镜像作为管理网关，避免多网卡容器的宿主端口依赖隐式网卡选择。两个管理路由都将方法限制为 GET，将路径限制为 HTTP/TCP 路由元数据。 [Compose 接线](https://github.com/MaLaNg116/itervane/blob/8b419bd/fixtures/ingress/reference/compose.yml) · [管理路由](https://github.com/MaLaNg116/itervane/blob/8b419bd/fixtures/ingress/reference/management.yml)
2. `8c151ba` 用固定 Traefik 可执行文件和可信应用容器运行网络试验。它创建一次性内部应用网，测试实际宿主 TLS、管理 GET 与禁用写方法，并在应用容器中验证管理与认证端点的网络不可达。测试中的授权服务为本机固定夹具，真实 Keycloak 与 OAuth2 Proxy 授权另有 #54 的七项验收。 [网络验收](https://github.com/MaLaNg116/itervane/blob/8c151baff3b06f004eb2b256d72e71a8a9c10ede/fixtures/ingress/reference/probe-network.sh) · [真实 OIDC](https://github.com/MaLaNg116/itervane/actions/runs/44943972070)

实际 Docker 29.1.5 与 Compose 5.0.1 上三项均通过，源码指纹 `f1defa3dc1d2bc9dcd5a562454f1b56679fd1ab6c17a71752d182afca2c8a5a4`。初次启动实测出现内部地址争用与降权后挂载权限问题，现配置为独立固定授权端点，夹具保留宿主私有父目录并让容器可读授权的测试资产。维护者的安装与回环验证说明以中英文保留。 [自托管说明](https://github.com/MaLaNg116/itervane/blob/8b419bd/fixtures/ingress/reference/README.md)

托管工作流通过七项真实身份及三项网络检查。隔离报告的源码指纹与本机相同，证明两边都读取了业务 Traefik 的实际管理 API，验证了匿名拒绝和受保护健康，并从应用容器核对认证服务和管理网卡的不可达。 [托管入口与隔离验证](https://github.com/MaLaNg116/itervane/actions/runs/44945649304) · [PR #55](https://github.com/MaLaNg116/itervane/pull/55)

D3 接续真实 Komodo 的获批 OCI、只读运行核验与持久化发布结算，最后用同一正式操作验收。
