# P0.5-A Review Guide：Komodo 原生发布与指定版本恢复

- 基线为 `149cfe7`（D2-A 已合入）。固定代码为 `66de740a10f24081b26f566bd1edd09d991bb037`。
- 计划见 [本批计划](../plans/p0-komodo-native-delivery.md)。正式任务的运行闸门见 [ADR 0001](../decisions/0001-development-and-runtime-gates.md) 和 [TS + PostgreSQL 阶段计划](../implementation-plan-v2-ts-postgresql.md)。

## 1. 从 GitHub 工作机到实际容器

1. `Native Komodo` 在一次性托管 Linux 工作机启动固定 digest 的 Komodo Core/Periphery 2.3.4、MongoDB 8.0.38 和 Distribution Registry 3.1.2。Core 和 Registry 仅绑定 loopback，临时注册的 Periphery 通过原生连接接入 Core。Periphery 使用本轮工作机的 Docker socket，终端和容器终端配置关闭。运行上下文和 fixture 路径由探针固定。 [验证工作流](https://github.com/MaLaNg116/itervane/blob/66de740a10f24081b26f566bd1edd09d991bb037/.github/workflows/native-komodo.yml) · [测试依赖](https://github.com/MaLaNg116/itervane/blob/66de740a10f24081b26f566bd1edd09d991bb037/fixtures/komodo/compose.yaml)
2. `publishFixture` 构建维护者提供的 A/B 两版微型 HTTP 样例。每版推送到本次 registry，重新计算返回的 OCI manifest 字节摘要，并与 registry digest、实际镜像配置摘要交叉核验。部署使用 `repository@sha256:…`。 [样例](https://github.com/MaLaNg116/itervane/blob/66de740a10f24081b26f566bd1edd09d991bb037/fixtures/komodo/Dockerfile) · [镜像核对](https://github.com/MaLaNg116/itervane/blob/66de740a10f24081b26f566bd1edd09d991bb037/packages/verification/src/native/komodo-probe.ts)
3. 管理凭证用于初始化两项 Deployment、临时服务账号和目标权限。服务账号只获得指定 Deployment 的 `Write`，读取另一项 Deployment 必须得到原生权限拒绝。Core 2.3.4 的本地登录使用 `{type,data}` 回执，资源拒绝可表现为 HTTP 500。只有匹配该 API 的拒绝记录时才确认负例通过。 [协议实现](https://github.com/MaLaNg116/itervane/blob/66de740a10f24081b26f566bd1edd09d991bb037/packages/verification/src/native/komodo.ts) · [上游资源权限](https://github.com/moghtech/komodo/blob/v2.3.4/bin/core/src/permission.rs)
4. 每轮先核对目标 ID、所属服务器和镜像配置，再发一次 `Deploy`。单独查询 `GetUpdate`，检查更新 ID、动作、目标、服务账号和完成结果。随后由测试进程读取实际容器的配置与镜像 ID，在容器内调用固定 HTTP 健康端点，并再次核对是同一容器。失败分支只读取实际状态后中止，按本轮标签清理样例。 [发布与恢复路径](https://github.com/MaLaNg116/itervane/blob/66de740a10f24081b26f566bd1edd09d991bb037/packages/verification/src/native/komodo-probe.ts) · [Komodo Deployment](https://komo.do/docs/deploy/containers)

## 2. 实测证据

GitHub 托管实测 [44711600569](https://github.com/MaLaNg116/itervane/actions/runs/44711600569) 运行固定代码。源码指纹为 `d0047eff4917296c31cb38b1c467a6b53ee2dddfd0bffbee2fd2fcf80634bd7a`。三个运行容器的配置与镜像分别核验，HTTP 响应依次为 A、B、A。

| 轮次 | 原生更新 ID | OCI manifest SHA-256 |
| --- | --- | --- |
| 首次发布 A | `6b0013deb90cfc5991fe1eb8` | `15e3a45a830919755950f288e2e723a0a1738199ce7bcb699570f411f17c1d80` |
| 升级 B | `6b0013dfb90cfc5991fe1ebb` | `63ffa50f3a113b5cd017a88a78f082ca81c7012882600b59b2ae86aa2d028d42` |
| 恢复 A | `6b0013eab90cfc5991fe1ec8` | `15e3a45a830919755950f288e2e723a0a1738199ce7bcb699570f411f17c1d80` |

A 的运行镜像配置 SHA-256 为 `ed83dee98514d125c5abb6e492351856d6af38b7552c23a89dcfe9ee5228faf3`，B 为 `ccc264554ed0e1177bc3454c820694c6aeaac566c81ff2d5fa6640c8b7ac3398`。作用域负例和本轮资源清理均通过。严格类型检查与 99 项单元测试通过，另验证 Windows 直接运行时 en/zh-CN 均返回缺少专用环境。 [协议回归](https://github.com/MaLaNg116/itervane/blob/66de740a10f24081b26f566bd1edd09d991bb037/packages/verification/test/unit/komodo-native.test.ts)

## 3. 复跑与后续验收

在 GitHub Actions 选择 `Native Komodo` 手动运行，或通过包含该工作流及探针改动的分支推送触发。工作流归档 `komodo-native-evidence`，可下载脱敏的 `.reports/p0/komodo-native.json`。探针支持 `ITERVANE_NATIVE_LOCALE=en|zh-CN`。每次运行生成独立凭证和样例摘要，公开回执只记录验证状态、版本、原生更新 ID 和镜像摘要。

本批用可信样例取得 P0.5 的 Komodo 证据。正式发布还有真实 Runner、独立复验、镜像扫描、领域审批、受保护入口及下游恢复验收。Whiskers 原生确认属于 P0.5 的另一项，完整 `native-operations` 汇总仍待验。
