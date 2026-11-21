# P2-E-C4-B2 · 正式 Komodo Worker 导读

基于已合入的 [步骤账本 PR #51](https://github.com/MaLaNg116/itervane/pull/51)。固定试验源码 `d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1`。 [Worker 交接计划](../plans/p2-e-formal-komodo-worker.md)

1. `c359e9c` 将写入授权和接收回执的观察授权分开。当前 Worker 的请求已经发出时，观察授权可记录其下游回执。后续写入仍会独立校验审批、租约及目标。 [受限适配器](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/src/runtime/release-komodo.ts)
2. `21f366b` 将已核验 Registry 的同一操作交接给单独的 Komodo 写入租约，持久化保留目标环境。已有配置和派发意图由新观察租约独立回读，三次自动观察预算在取得租约时记账。已记录的终态进入待上线核验并释放全局执行槽。缺少原生更新 ID 时保留环境占用并转人工。 [调度与恢复](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/src/runtime/release-queue.ts) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/migrations/0035_formal_komodo_worker.sql)
3. `26aebd1` 将受限适配器接到正式 Worker。配置回读一致后才能派发，派发回执先持久化更新 ID，终态来自独立读取。源码 Runner 和 Registry 仍只负责此前的制品部分。 [Worker](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/src/runtime/formal-release-worker.ts)
4. `5451e7f` 用两份来自真实 Runner 的获批制品及临时 Core/Periphery 演练。在实际配置变更后终止子进程，再核对已保存与未保存更新 ID 的两条路径。验收检查实际容器身份、审计阶段、一次配置和一次派发。专用子进程从管道接收临时服务身份，报告仅保留验证所需的数据。 [原生故障验收](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/test/native/komodo-release-proof.ts)

TypeScript、179 项单元、十项真实 PostgreSQL 专项及原生 Worker 打包通过。首次全量数据库回归通过 160/161 项，配置响应丢失用例等待唤醒超时。一次专项复跑在等待配置观察及撤权结算时仍观察到队列记录处于 `created`。`8106579` 保留队列可执行时间和数据库时钟，并按实际状态等待撤权结算。固定源码 `8106579a3f8f603aee3da90af33b98c9e04f0e3e` 专项已重新通过，全量正在复跑。

独立原生 Komodo 适配器检查已通过。使用真实 Runner 制品的进程中断试验正在托管环境验收。生产入口依赖 E-D 的实际运行版本、访问保护和健康核验。 [PR #52](https://github.com/MaLaNg116/itervane/pull/52) · [原生 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/44938461015) · [托管 Runner](https://github.com/MaLaNg116/itervane/actions/runs/44938461019)
