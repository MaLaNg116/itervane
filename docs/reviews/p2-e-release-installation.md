# P2-E-D3-C1 · 发布 Worker 安装导读

接续 [上线结算 #57](https://github.com/MaLaNg116/itervane/pull/57)。固定代码 `38e9dec91d6b23ed2382bf8dfafbac77dbfd7ff5`。 [D3-C 计划](../plans/p2-e-release-installation.md)

1. `3dded18` 启动前核对维护者登记的保护环境和目标指纹。独立进程分别轮询发布写入与只读结算。写入沿用全局执行槽和人工授权，观察使用自己的短租约。已排队的其他环境操作保留唤醒，安装身份无法取得它的执行权。 [启动入口](https://github.com/MaLaNg116/itervane/blob/3dded18/packages/control-plane/src/entries/release-worker.ts) · [写入协调器](https://github.com/MaLaNg116/itervane/blob/3dded18/packages/control-plane/src/runtime/formal-release-claim.ts) · [核验协调器](https://github.com/MaLaNg116/itervane/blob/3dded18/packages/control-plane/src/runtime/formal-rollout-claim.ts)
2. `df5f1ad` 核对配置缺项、其他环境、注册目标漂移及错误指纹无法取得只读租约。测试使用持久化发布队列和真实数据库，外部写入使用可观测夹具。 [安装闸门回归](https://github.com/MaLaNg116/itervane/blob/df5f1ad/packages/control-plane/test/integration/inspections.test.ts)
3. `38e9dec` 在队列消费前通过 Komodo 自身的 `ListApiKeys` 核对当前密钥属于登记服务身份。请求和响应只在发布进程内使用，日志记录固定错误码。 [受限适配器](https://github.com/MaLaNg116/itervane/blob/38e9dec/packages/control-plane/src/runtime/release-komodo.ts) · [Komodo v2.3.4 实现](https://github.com/moghtech/komodo/blob/v2.3.4/bin/core/src/api/read/user.rs#L92)

TypeScript 与 202 项单元通过。`df5f1ad` 在真实 PostgreSQL 17.12 通过十项安装及上线核验专项和 171 项全量，源码指纹 `aa5199d69feb0b0a0f20fa460511d0383142145b1427d2f8f794c9daabcdd809`。核对密钥归属后的代码通过托管 PostgreSQL、浏览器和扫描器回归。未配置的实际启动进程返回退出码 1，日志为固定错误消息。

Komodo v2.3.4 原生验证通过六项检查，包含发布前验证同一密钥的正确与错误账号。原生报告及四组通过的托管 KVM 回归使用源码指纹 `b8fe4162a8d2a36115758b384633a1e4a51406e1021da79162c8d4f308f3044e`。隔离回归观察到五个临时域，OCI 回归保留正常和未知原生更新的两条恢复路径。 [常规 CI](https://github.com/MaLaNg116/itervane/actions/runs/44950737250) · [原生 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/44950649151) · [托管 Runner](https://github.com/MaLaNg116/itervane/actions/runs/44950649076)

在审查版本 `53e71f3b1a5127e3aa4711b1cc18da2a001157b1` 核对了安装指纹、身份所有者、独立观察与执行权的边界及其他环境的唤醒。两组主线常规检查通过。已合入 `9545c6691b19f53db511688dbd4f0d1badb98661`。C2 接入双语结果，D3-D 用同一发布操作完成真实端到端验收。 [PR #58](https://github.com/MaLaNg116/itervane/pull/58) · [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44952668649) · [分支 CI](https://github.com/MaLaNg116/itervane/actions/runs/44952664936)

## 安装配置

使用 Linux 上已验证的 Runner 与受保护入口参考配置。通过 `pnpm register:release-target <配置文件>` 登记完整目标，保留输出的 `environmentId` 和 `fingerprint`。由维护者向专用进程提供这些变量，再运行 `pnpm start:release-worker`。 [自托管入口](../../fixtures/ingress/reference/README.md)

| 变量 | 用途 |
| --- | --- |
| `DATABASE_URL` | 已迁移的控制面运行账号 |
| `ITERVANE_RUNNER_SOCKET`、`ITERVANE_RUNNER_UID`、`ITERVANE_RUNNER_IMAGE_SHA256` | Runner 本机通道、身份和镜像 |
| `ITERVANE_RELEASE_ENVIRONMENT_ID`、`ITERVANE_RELEASE_TARGET_SHA256` | 登记的环境与目标指纹 |
| `ITERVANE_RELEASE_MATERIALIZER`、`ITERVANE_RELEASE_SKOPEO` | 维护者安装的 `materialize_oci.py` 和 `skopeo` 的绝对路径，Python 文件与其依赖放在同一可信目录 |
| `ITERVANE_RELEASE_KOMODO_KEY`、`ITERVANE_RELEASE_KOMODO_SECRET` | 登记的 Komodo 服务账号凭证 |
| `ITERVANE_RELEASE_PROBE_SECRET` | 登记的 Keycloak 探测客户端密钥 |
| `ITERVANE_RELEASE_REGISTRY_USER`、`ITERVANE_RELEASE_REGISTRY_PASSWORD` | Registry 使用认证时成对提供 |

进程环境由宿主服务管理器或私密配置注入。发布凭证留在发布进程，API 和普通任务 Worker 使用各自的环境。

## English

Use the qualified Linux Runner and protected ingress reference. Enroll the full release target and use its environment ID and fingerprint for the variables above. Install the OCI materializer with its sibling Python modules and Skopeo in operator-controlled paths. Provide the enrolled Komodo credentials, Keycloak probe secret and, when required, Registry credentials through the dedicated process environment. Start it with `pnpm start:release-worker`.
