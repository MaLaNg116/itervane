# P2-E-C4-A · 正式 Komodo 目标与受限适配

基于 [Registry 导入与恢复 #49](https://github.com/MaLaNg116/itervane/pull/49)。本批固定源码为 `5d34ebcca72e45172c0b594852387e41c8b11a8c`，使用临时 Komodo Core/Periphery 2.3.4 和可信样例验证。 [实施计划](../plans/p2-e-formal-komodo-target.md)

## 建议阅读顺序

1. `34224ba` 将 Komodo 来源和服务身份纳入受保护环境的目标版本。Komodo、Registry 和下游资源继续由安装维护者登记。旧登记的内容和指纹仍可校验，补登或更换绑定会更新版本。候选沿用既有目标版本校验。 [目标契约](https://github.com/MaLaNg116/itervane/blob/5d34ebcca72e45172c0b594852387e41c8b11a8c/packages/contracts/src/release.ts) · [目标登记](https://github.com/MaLaNg116/itervane/blob/5d34ebcca72e45172c0b594852387e41c8b11a8c/packages/control-plane/src/service/release-targets.ts)
2. 阅读 `KomodoReleaseClient` 的 `inspectTarget → configureImage → dispatch → observeUpdate`。适配器核对实际服务地址与账号、Deployment 和服务器，校验名称和除镜像外的完整运行配置。名称参与指纹，因为 Komodo 用它派生容器名。唯一允许修改的配置字段是来自已绑定 Registry 和仓库的固定摘要镜像。每次成功读取和写入的前后均调用执行权校验。派发与结果核对绑定原生更新 ID、Deployment、动作、服务身份，传输失败会交回调用方处理。 [正式适配器](https://github.com/MaLaNg116/itervane/blob/5d34ebcca72e45172c0b594852387e41c8b11a8c/packages/control-plane/src/runtime/release-komodo.ts)
3. `9778903` 覆盖改名、配置漂移、危险运行配置、撤权与丢失回执。真实 PostgreSQL 用例覆盖规范来源等价、账号轮换带来的目标版本变化，以及旧批准拒绝。 [适配器用例](https://github.com/MaLaNg116/itervane/blob/5d34ebcca72e45172c0b594852387e41c8b11a8c/packages/control-plane/test/unit/release-komodo.test.ts) · [审批失效用例](https://github.com/MaLaNg116/itervane/blob/5d34ebcca72e45172c0b594852387e41c8b11a8c/packages/control-plane/test/integration/inspections.test.ts)
4. `5d34ebc` 复用原生验收的临时 Core、Periphery、Registry 与服务凭证。三轮 P0 实证各自保留结果，另增一轮适配器实测。新增检查同时核对来源、身份、目标、原镜像和配置漂移，随后派发一次并回读实际容器及健康响应。 [真实样例与权限核对](https://github.com/MaLaNg116/itervane/blob/5d34ebcca72e45172c0b594852387e41c8b11a8c/packages/verification/src/native/komodo-probe.ts)

## 进度与审查重点

TypeScript 和 178 项单元已通过。固定托管提交 `1c20fa532c958e0cfb0356cacc227e88bfe0119a` 通过六项 Komodo 检查。适配器使用独立的原生更新 ID，实际镜像配置和 OCI manifest 均与同版样例一致，运行配置摘要为 `4423de19a6e3d329740365b8f00b52599e3e9cd19f1680d50314f1aacb52fd5f`。报告仅保留操作 ID、匹配结果和摘要。 [PR #50](https://github.com/MaLaNg116/itervane/pull/50) · [Komodo 原生验收](https://github.com/MaLaNg116/itervane/actions/runs/44932748682)

真实 PostgreSQL 首轮通过 151/152 项，目标绑定用例通过，既有源码回执接续审计用例缺少预期审计结果。相同源码专项复跑两项通过，失败原因尚未定位，全量复跑中。 [托管 Runner 回归](https://github.com/MaLaNg116/itervane/actions/runs/44932748615)

正式派发需要 C4-B 的配置和部署意图、丢失回执后的只读核对，以及 E-D 的实际版本、访问保护和健康检查。Komodo 接口使用分开的读取和派发请求，安装侧需要让平台独占已登记目标的写入路径，避免域外写入发生在读取与派发的间隔。生产入口仍处于关闭状态。
