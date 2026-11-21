# P2-E-D1 · 运行镜像与容器边界导读

基于 [Komodo Worker PR #52](https://github.com/MaLaNg116/itervane/pull/52)，固定源码 `f87c7b371e246d6d2cb53cca6e3bb5bb62428f53`。 [PR #53](https://github.com/MaLaNg116/itervane/pull/53) · [上线核验计划](../plans/p2-e-rollout-verification.md)

`8d7c340` 的 `inspectRuntime` 先核对版本化目标的当前部署配置，再按同一目标独立读取实际容器。它检查实际镜像引用及配置摘要、运行状态、无宿主端口绑定、非特权运行和唯一登记网络。证据只保留操作核对需要的容器标识、镜像及网络，容器环境等原生字段不外传。 [只读适配器](https://github.com/MaLaNg116/itervane/blob/f87c7b371e246d6d2cb53cca6e3bb5bb62428f53/packages/control-plane/src/runtime/release-komodo.ts)

`f87c7b3` 加入六项单元用例及原生证据对照。原生试验将同一容器的 Komodo 读取结果与从临时宿主取得的实际容器 ID 和镜像摘要比对。首轮实测完成样例发布、升级和恢复，在正式读取容器时收到 HTTP 拒绝。固定版 Komodo 要求 Deployment 的 `Inspect` 专项权限，普通 `Write` 只提供配置权限。 [首轮原生 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/44939271077) · [原生读取权限](https://github.com/moghtech/komodo/blob/v2.3.4/bin/core/src/api/read/deployment.rs#L293)

`9e21046` 让原生验收先验证缺少权限时读取受阻，再只对登记 Deployment 授予 `Inspect` 并核对实际容器。有限的 HTTP 状态用于原生报告定位故障。TypeScript 和 185 项单元通过，权限修正的原生核验待复跑。入口授权、健康探测及正式结算在后续 D2/D3 批次推进。 [原生夹具](https://github.com/MaLaNg116/itervane/blob/9e21046ed4787cf2492c240714f5a7af35a086f8/packages/verification/src/native/komodo-probe.ts) · [托管 Runner](https://github.com/MaLaNg116/itervane/actions/runs/44939271145)
