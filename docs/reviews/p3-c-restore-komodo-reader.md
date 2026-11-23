# P3-C2d2b1 · Komodo 独立回读导读

依赖 #108，固定代码与测试为 `7d3a61589903191702c514752b01e604d7324ab8`。 [实施计划](../plans/p3-c-operations-restore.md) · [PR #109](https://github.com/MaLaNg116/itervane/pull/109)

1. 复用重启核对的独立读身份和固定目标校验。读接口能核对部署配置、容器和指定更新。读取更新时使用独立凭证，核验结果时使用原登记的写入者和部署 ID。 [只读适配器](https://github.com/MaLaNg116/itervane/blob/7d3a61589903191702c514752b01e604d7324ab8/packages/control-plane/src/runtime/release-komodo.ts#L124)
2. 单元测试核对发往原生接口的调用凭证和请求更新 ID，并拒绝被替换的部署、更新 ID、原写入者。正式发布写入端仍使用原目标绑定。 [更新回读验证](https://github.com/MaLaNg116/itervane/blob/7d3a61589903191702c514752b01e604d7324ab8/packages/control-plane/test/unit/release-komodo.test.ts#L180)
3. 托管样例使用真实 Komodo Read 角色核对写身份完成的部署配置和更新。原生权限拒绝写入及跨部署读取。同一套流程复核了镜像、受保护网络和停止后启动的容器。 [原生用例](https://github.com/MaLaNg116/itervane/blob/7d3a61589903191702c514752b01e604d7324ab8/packages/verification/src/native/komodo-probe.ts#L293)

TypeScript、247 项单元测试及十项原生 Komodo 检查通过。托管产物的源码指纹为 `37f7fbd2fc4c51b7b974e2b8b7c1c3ca6fac56a7357d913ada548ecd15f6af2a`。指定版本的实际配置变更和持久化派发在 C2d2b2 验收。 [托管原生任务](https://github.com/MaLaNg116/itervane/actions/runs/45018810794/job/137196935607) · [证据产物](https://github.com/MaLaNg116/itervane/actions/runs/45018810794/artifacts/14753066990)
