# 参考环境的受保护发布

使用同一固定 Itervane 版本安装参考控制面和 KVM Runner。示例使用固定源码、标准 Web 构建和 OCI 配置。审计 Worker 使用已配置的 Anthropic 或 OpenAI 协议模型，发布 Worker 使用登记的 Komodo、Registry 和入口探测身份。 [控制面安装](reference-installation.md) · [Runner 安装](reference-runner-installation.md)

## 登记发布目标

1. 创建项目和仓库。维护者用平台 API 创建应用和受保护环境，保留 API 返回的环境 ID。资源接口是 `POST /v1/projects/<项目 ID>/applications` 和 `POST /v1/projects/<项目 ID>/environments`。通过已登记的 OIDC 客户端获取面向平台 API 的令牌，使用当前项目有权创建资源的人员身份。 [资源接口](control-plane-p1-a.md)
2. 在 Komodo 中登记专用 Deployment 和 Periphery 主机。部署应用加入专用内部桥接网络，保留容器内服务端口。从发行镜像地址准备 Registry，在 Worker 和部署主机核对 Registry 的连通性与凭证。为发布进程使用登记的 Komodo 账号。 [原生 Komodo 安装验证](reviews/p0-komodo-native-delivery.md) · [受保护应用入口](../fixtures/ingress/reference/README.md)
3. 配置独立的应用 Keycloak 客户端和只读健康探测服务账号。核对应用 HTTPS、Traefik 只读管理地址、服务网和 `/health`。将环境、Komodo 资源、Registry、运行配置、复验配置、健康检查和恢复计划填入私有目标 JSON。 [目标契约](../packages/contracts/src/release.ts) · [Komodo 配置摘要](../packages/control-plane/src/runtime/release-komodo.ts) · [复验配置摘要](../packages/control-plane/src/service/repair-retry.ts) · [上线探测摘要](../packages/control-plane/src/service/release-targets.ts)

在可信维护者终端使用参考 API 配置和私有目标文件执行登记。保留返回的 `environmentId` 与 `fingerprint`。

```sh
node --env-file="$reference_dir/api.env" --import tsx \
  packages/control-plane/src/entries/register-release-target.ts "$reference_dir/release-target.json"
```

## 启动、申请和核对

将发布 Worker 的登记指纹、Runner 连接、OCI materializer、Skopeo 和专用下游凭证写入私有 `release.env`。运行账号需要登记的 Runner socket 权限和运行数据库角色。命令从可信 checkout 启动。

```sh
node --env-file=/run/itervane/release.env --import tsx packages/control-plane/src/entries/release-worker.ts
```

1. 外部 MCP 使用 PKCE 和 `itervane:read itervane:write` 提交固定源码任务。完成审计、受支持的修复和独立复验后，使用任务当前版本和已登记环境调用 `request_release`。
2. 登录门户核对候选镜像、复验、目标和审批有效期。人工批准后，由发布 Worker 导入 Registry、请求 Komodo、核对运行版本与应用入口。 [发布 Worker 配置表](reviews/p2-e-release-installation.md#安装配置)
3. 从门户和 MCP `get_release_result` 查询同一操作、更新 ID、镜像摘要和核对时间。检查预期版本的授权健康请求成功、匿名健康请求被拒绝。结果未知时保留当前操作，先核对已经发生的下游动作。 [发布核对](reviews/p2-e-release-installation.md) · [冷备与恢复](control-plane-backup.md)

## English

Install the reference control plane and qualified KVM Runner from the same pinned revision. Register the HTTPS repository, application and protected environment through the project API with an authorized operator identity. Prepare a pinned Registry and Komodo deployment on a dedicated internal application network. Use the protected ingress reference and a separate Keycloak health probe identity.

Record the target with the registration command above and pass its environment ID and fingerprint to the dedicated release Worker along with the Runner binding and scoped downstream credentials. Submit a fixed revision with the external MCP write scope. After repair and independent verification, request release for the current task version. Approve the identified candidate in the signed-in portal. Verify the update ID, digest and running version through the portal, external MCP and protected health endpoint.
