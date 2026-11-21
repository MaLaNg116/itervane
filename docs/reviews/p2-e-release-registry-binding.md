# P2-E-C3-A · Registry 来源与审批目标版本绑定

基于 [同摘要 Registry 导入 #45](https://github.com/MaLaNg116/itervane/pull/45)。 [执行权实施计划](../plans/p2-e-formal-release-execution.md#c3-执行权分批)

1. `0469b85` 在正式目标登记中引入 `registryOrigin`，和镜像仓库名一同纳入已有目标指纹和版本。规范化 HTTPS 来源或显式本机回环来源。旧记录保留原 JSON 形状，因此已存指纹仍可校验。正式导入需要带来源的目标登记。 [目标契约](https://github.com/MaLaNg116/itervane/blob/0469b85/packages/contracts/src/release.ts)
2. 导入适配器由受信任 Worker 配置选择 Registry。进入文件与网络操作前，适配器核对目标绑定的规范来源和本次实际配置相同。目标仓库也采用登记字段。门户与 MCP 使用已有授权展示投影。 [Worker 目标核对](https://github.com/MaLaNg116/itervane/blob/0469b85/packages/control-plane/src/runtime/release-registry.ts)
3. `7489035` 在真实 PostgreSQL 验证补登来源会递增版本并使已冻结候选失效，等价地址重放保持同版本，远程明文地址被拒绝。托管流程先创建临时 Registry 和版本化目标，再冻结并批准第二代镜像，独立验证实际 Registry 地址和目标映射摘要。 [数据库验证](https://github.com/MaLaNg116/itervane/blob/7489035/packages/control-plane/test/integration/inspections.test.ts) · [正式候选与传输](https://github.com/MaLaNg116/itervane/blob/7489035/packages/control-plane/test/native/release-archive.ts)

固定源码 `7489035926aa3e37f3f9bd6d8df2fa5cb597c669`。TypeScript、163 项单元和原生 Worker 打包通过。本机非 root 的 Distribution 3.1.2 路径验证换源、缺失历史配置和额外 URL 路径都在进入执行权及暂存之前拒绝，规范地址的同摘要导入通过。首次 PostgreSQL 137 项通过，既有「接管已记录修复」用例返回 `incompatible_checkpoint`。相同源码指纹 `aaf7ce3ea026a357ce0f71b3f13de0068fea16d3d96183efe27a9d19409a2c36` 全量复跑 138 项通过。该次波动的原因尚未定位。 [PR #46](https://github.com/MaLaNg116/itervane/pull/46) · [托管验收](https://github.com/MaLaNg116/itervane/actions/runs/44922298771)

C3-B 接入全局执行槽和正式队列认领。登记变更使用现有目标锁，待派发操作还需要重验授权版本、有效期和证据。

在 #45 合入后的 `main` 上核对托管版本 `32a9ae659afb86a6ef4977bbdfb8b20c3228a178`，运行代码一致。托管 OCI 验收已通过，冻结目标来源、批准操作、归档、镜像及配置摘要均与真实 Registry 回读一致，独立制品记录确认暂存清理。 [基于 main 的 #46](https://github.com/MaLaNg116/itervane/pull/46) · [托管验收](https://github.com/MaLaNg116/itervane/actions/runs/44922298771)

四组托管验收和常规 CI 均通过。已审查版本 `d92b31d2871b543b27c5a172c563179e5e930270` 已合入 `main`。 [合并提交](https://github.com/MaLaNg116/itervane/commit/000ad7425c3dfd71d70378af81439cb968476418)
