# 自托管应用入口

这份配置为一个由 Komodo 部署的应用提供 TLS、Keycloak 授权和只读核验入口。安装者选择 Docker Compose 项目名、应用域名、正式证书和专用桥接网络。

1. 创建专用的内部应用网络，比如 `docker network create --internal itervane-demo-private`。给登记的 Komodo Deployment 配置这个网络、固定的容器名和容器内部服务端口。保留宿主端口映射关闭。
2. 复制 `traefik.example.yml` 到维护者管理的配置目录。把其中的域名、容器名和端口改为登记值。TLS 目录提供 `certificate.pem` 和 `key.pem`，并设置可信代理可读的文件权限。
3. 复制 `oauth2-proxy.example.cfg` 并填写应用专用 Keycloak 客户端、授权组和准确的 HTTPS 回调。单独的探测客户端使用服务账户、该应用的 audience 和应用授权组，令牌有效期最多 300 秒。保留默认的 Traefik 认证网地址，或者同步调整 `trusted_proxy_ips`。
4. 用安装配置提供下列路径和网络名。为 OAuth2 Proxy 安装单独的私密环境文件，包含 `OAUTH2_PROXY_CLIENT_SECRET` 和 `OAUTH2_PROXY_COOKIE_SECRET`。

| 安装变量 | 值 |
| --- | --- |
| `ITERVANE_APPLICATION_NETWORK` | 已创建的专用内部桥接网络 |
| `ITERVANE_TRAEFIK_CONFIG_DIR` | 仅维护者可修改的 Traefik 动态配置目录 |
| `ITERVANE_INGRESS_TLS_DIR` | 证书和私钥目录 |
| `ITERVANE_OAUTH2_CONFIG` | 应用授权配置文件 |
| `ITERVANE_OAUTH2_SECRETS_FILE` | 私密环境文件路径 |

以 `docker compose --env-file <安装配置> -f fixtures/ingress/reference/compose.yml config --quiet` 核对后启动服务。应用 HTTPS 默认为 `127.0.0.1:8443`，管理 API 为 `127.0.0.1:8180`。在自托管入口登记时，使用同一个 Traefik 实例实际提供的 HTTPS origin 和管理 origin。暴露业务 HTTPS 时显式配置 `ITERVANE_INGRESS_BIND`。浏览器可以访问本应用的 `/oauth2/start?rd=/` 提交 OIDC 登录。

回环管理端口由仅加入管理网络的 Traefik 实例转发到业务代理的管理网卡。两个入口都只允许读取 HTTP/TCP 路由信息。OAuth2 Proxy 仅加入认证网络。应用只加入自己的内部网络，由业务代理将应用路径和 `GET /health` 转给登记的容器和端口。 [文件 provider](https://doc.traefik.io/traefik/reference/dynamic-configuration/file/) · [Compose internal 网络](https://docs.docker.com/reference/compose-file/networks/#internal) · [Keycloak 应用授权](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.6/docs/docs/configuration/providers/keycloak_oidc.md)

## English

Create a dedicated internal Docker bridge for the registered Komodo container and leave its host port mappings disabled. Copy the Traefik and OAuth2 Proxy examples into operator-owned configuration paths. Set the application hostname, TLS certificate, container DNS name and port, Keycloak application client, group and exact HTTPS callback. Keep OAuth2 Proxy client and cookie secrets in a separate private environment file.

Set the five installation variables listed above and validate the Compose configuration before starting it. Application TLS defaults to `127.0.0.1:8443` and management reads default to `127.0.0.1:8180`. Set `ITERVANE_INGRESS_BIND` explicitly for external application access. Enroll the same Traefik instance and a short-lived Keycloak service account for the application health probe. The browser login path is `/oauth2/start?rd=/`.
