# P2-E-D3-D2-A · 真实受保护入口夹具导读

依赖 [隔离发布目标 #60](https://github.com/MaLaNg116/itervane/pull/60)。固定代码版本 `81ede16bed39f5cb369afc7318956dfc0af21f7a`。 [分批计划](../plans/p2-e-protected-release-workflow.md)

1. 提取现有 Keycloak 夹具的应用 audience、短时探测身份和授权组。两个测试身份使用相同 audience，用组成员资格区分能否访问应用。 [Realm 夹具](https://github.com/MaLaNg116/itervane/blob/3261fe7/packages/verification/src/native/rollout-realm.ts)
2. 入口测试复用自托管 Compose 的应用、管理和认证三种网络。以已核对摘要的 Traefik 和 OAuth2 Proxy 可执行文件以及真实 Keycloak 启动，生成分别用于应用入口和身份服务的测试证书。启动前检查目标应用网的归属和内部模式，仅在宿主回环提供应用 HTTPS 和只读管理入口。 [启动及清理](https://github.com/MaLaNg116/itervane/blob/81ede16/packages/control-plane/test/native/protected-ingress.ts)
3. 原生入口验收通过正式 Traefik 检查器读取真实 HTTP/TCP 路由，测试托管 TLS、匿名拒绝、探测身份正确授权、其他路径及请求方法拒绝、应用看不到认证和管理服务。应用收到授权后的真实请求时拒绝残留的认证头。 [测试及报告](https://github.com/MaLaNg116/itervane/blob/81ede16/packages/control-plane/test/native/protected-ingress-smoke.ts)

本机 TypeScript 与 202 项单元测试通过。托管入口在 `2003be9` 通过七项既有检查与五项实际网络检查，两份报告源码指纹均为 `0d208db45a79123d567faac46b54596bd416d8b89af6bbcd9ce7740dae00bb08`。实际 Traefik 仅在回环提供只读管理观察，Keycloak 身份经过 TLS 获取短时令牌，只有匹配应用组的令牌在健康路径被接受。检查了认证和管理网不可达，以及所有本轮资源回收。 [托管入口报告](https://github.com/MaLaNg116/itervane/actions/runs/44955789630)

四组托管 KVM 全部通过，回归与 OCI 报告的源码指纹和入口证据一致。审查复核了证书来源、探测凭证范围、应用网络绑定和资源清理。`66267470a0c70fa57e7b1129a0e1c39a6031233e` 的六项常规检查均通过，生产及测试代码与托管验收版本一致，已合入 `98f5142ca615a099fd5b520d203eae7e4c077cbd`。 [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44955789647) · [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44958291563) · [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44958286853)
