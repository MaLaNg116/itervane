# v0.1 组件与许可证 / Components and licenses

Itervane 自有代码采用 Apache-2.0。源码归档包含项目代码、冻结的依赖锁文件和随源码保留的许可声明。第三方依赖由安装者从上游取得，分别使用其声明的许可证。安装时以归档中的固定配置为准。 [项目许可证](../LICENSE) · [源码包与校验](source-release.md)

## 自托管组件 / Self-hosted components

| 组件 / Component | 参考版本与固定来源 / Reference versions and pins | 上游许可证 / Upstream license |
| --- | --- | --- |
| PostgreSQL | 17，参考镜像按 SHA-256 固定。 [Compose](../packages/control-plane/ops/reference/compose.yml) | [PostgreSQL License](https://www.postgresql.org/about/licence/) |
| Keycloak | 26.8.2，控制面与受保护应用探测同版。 [Compose](../packages/control-plane/ops/reference/compose.yml) · [入口固定项](../fixtures/ingress/versions.json) | [Apache-2.0](https://github.com/keycloak/keycloak/blob/26.8.2/LICENSE.txt) |
| Komodo Core / Periphery | 2.3.4，登记的部署与独立读回。 [参考镜像](../fixtures/komodo/compose.yaml) | [GPL-3.0](https://github.com/moghtech/komodo/blob/v2.3.4/LICENSE) |
| MongoDB Community | 8.0，参考 Komodo 实例的存储。 [参考镜像](../fixtures/komodo/compose.yaml) | [SSPL-1.0](https://www.mongodb.com/legal/licensing/server-side-public-license) |
| OCI Distribution Registry | 3，参考 Registry 镜像按摘要固定。 [参考镜像](../fixtures/komodo/compose.yaml) | [Apache-2.0](https://github.com/distribution/distribution/blob/v3.0.0/LICENSE) |
| Whiskers | 0.15.0，原生观察与确认。 [固定镜像和源码](reviews/p0-whiskers-native-approval.md) | [Apache-2.0](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/LICENSE) |
| Traefik / OAuth2 Proxy | 3.7.18 / 7.15.6，固定二进制和镜像。 [二进制摘要](../fixtures/ingress/versions.json) · [Compose](../fixtures/ingress/reference/compose.yml) | [Traefik MIT](https://github.com/traefik/traefik/blob/v3.7.18/LICENSE.md) · [OAuth2 Proxy MIT](https://github.com/oauth2-proxy/oauth2-proxy/blob/v7.15.6/LICENSE) |
| Runner 与 OCI | Ubuntu 24.04 x86_64、KVM / QEMU / libvirt。Guest 输入和 OCI 基础镜像分别固定，umoci 0.6.0 按摘要校验。 [宿主安装](reference-runner-installation.md) · [Guest 镜像固定项](../fixtures/runner/prepare-probe-image.sh) · [OCI 输入](../scripts/prepare-runner-oci-inputs.sh) | [Ubuntu 组件许可说明](https://ubuntu.com/legal/intellectual-property-policy) · [libvirt 许可](https://libvirt.org/copyright.html) · [QEMU 许可](https://www.qemu.org/docs/master/about/license.html) · [umoci Apache-2.0](https://github.com/opencontainers/umoci/blob/v0.6.0/COPYING) |
| Gitleaks / Trivy | 8.30.1 / 0.76.2，固定分发归档 SHA-256。Trivy 离线数据库按封存记录绑定。 [扫描工具固定项](../scripts/scanner-tools.ts) · [离线输入](../scripts/prepare-runner-inspection.ts) | [Gitleaks MIT](https://github.com/gitleaks/gitleaks/blob/v8.30.1/LICENSE) · [Trivy Apache-2.0](https://github.com/aquasecurity/trivy/blob/v0.76.2/LICENSE) |
| Semgrep CE | 1.170.0，离线引擎和依赖 wheel 由哈希锁定。 [固定依赖](../fixtures/runner/semgrep-requirements.txt) | [CE 引擎 LGPL 2.1 与规则许可](https://docs.semgrep.dev/licensing) |
| 门户 / Portal | shadcn/ui 的使用版本和改动、GSAP 3.15.1 与 `@gsap/react` 2.1.2。 [UI 声明](third-party-ui.md) | [shadcn/ui MIT](../packages/portal/public/shadcn-LICENSE.txt) · [GSAP Standard No Charge License](https://gsap.com/community/standard-license/) |

镜像内的操作系统包依照各上游镜像的声明。MongoDB Community 的 SSPL 和 GSAP 的 Standard License 随各组件适用。GSAP 用于门户本身的动效，部署构建保留 UI 许可声明。`dependency-licenses.json` 记录打包平台实际安装的 npm 包、版本和上游声明，`pnpm-lock.yaml` 固定依赖图、平台选择和完整性。 [UI 构建许可](third-party-ui.md)

## 模型与规则 / Models and rules

在 Worker 私有环境中选择 `ITERVANE_AUDIT_MODEL_PROVIDER=anthropic`，提供 `ANTHROPIC_API_KEY`、`ANTHROPIC_MODEL` 和可选的 `ANTHROPIC_BASE_URL`。选择 `openai` 时使用相应的 `OPENAI_API_KEY`、`OPENAI_MODEL` 与可选的 `OPENAI_BASE_URL`。模型服务的授权、计费、数据政策和运行环境由自托管者选择。模型与凭证通过安装配置提供。用 `MODEL_PROVIDER` 选择可信本机环境中 `pnpm probe:model` 的协议。 [配置示例](../.env.example) · [参考 Runner 和 Worker 设置](reference-runner-installation.md)

内置规则目录的来源和许可写在 `packages/rules/src/catalog.ts`，项目规则采用 Apache-2.0。Semgrep CE 使用任务固定的已审查规则，规则的许可取自该规则包。上传的设计 Skill、参考资料和规则由上传方提供适用许可，审核和发布记录保存版本与来源。Semgrep Inc. 维护的规则库单独授权，源码发布包只随项目发布自身的规则和样例。 [项目规则目录](../packages/rules/src/catalog.ts) · [Semgrep 规则授权](https://docs.semgrep.dev/licensing) · [规则治理](blueprint-v6.md)

## English

The Itervane source archive includes the project's code, the frozen lockfile and the notices carried in the repository. Install the separately licensed dependencies from the upstream locations pinned above. The build's `dependency-licenses.json` records declared licenses for the packages installed for its platform. Keep the portal's notices with the compiled application. Model endpoints, credentials and terms are configured by the operator. Imported skills and published rules carry their own provenance and license declarations. [Source release](source-release.md#english) · [Portal notices](third-party-ui.md)
