# P2-E-C4-B2 · 正式 Komodo Worker 导读

基于已合入的 [步骤账本 PR #51](https://github.com/MaLaNg116/itervane/pull/51)。固定试验源码 `d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1`。 [Worker 交接计划](../plans/p2-e-formal-komodo-worker.md)

1. `c359e9c` 将写入授权和接收回执的观察授权分开。当前 Worker 的请求已经发出时，观察授权可记录其下游回执。后续写入仍会独立校验审批、租约及目标。 [受限适配器](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/src/runtime/release-komodo.ts)
2. `21f366b` 将已核验 Registry 的同一操作交接给单独的 Komodo 写入租约，持久化保留目标环境。已有配置和派发意图由新观察租约独立回读，三次自动观察预算在取得租约时记账。已记录的终态进入待上线核验并释放全局执行槽。缺少原生更新 ID 时保留环境占用并转人工。 [调度与恢复](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/src/runtime/release-queue.ts) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/migrations/0035_formal_komodo_worker.sql)
3. `26aebd1` 将受限适配器接到正式 Worker。配置回读一致后才能派发，派发回执先持久化更新 ID，终态来自独立读取。源码 Runner 和 Registry 仍只负责此前的制品部分。 [Worker](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/src/runtime/formal-release-worker.ts)
4. `5451e7f` 用两份来自真实 Runner 的获批制品及临时 Core/Periphery 演练。在实际配置变更后终止子进程，再核对已保存与未保存更新 ID 的两条路径。验收检查实际容器身份、审计阶段、一次配置和一次派发。专用子进程从管道接收临时服务身份，报告仅保留验证所需的数据。 [原生故障验收](https://github.com/MaLaNg116/itervane/blob/d9bd951f5bcb83e54c89ad1b0ace2d78642ac9b1/packages/control-plane/test/native/komodo-release-proof.ts)

TypeScript、179 项单元、十项真实 PostgreSQL 专项及 161 项 PostgreSQL 全量通过。两次早期全量各通过 160/161 项，一次在配置回读等待超时，一次未取得既有修复样例的前置结果。`8106579` 补充可执行时间和数据库时钟，`68c1376` 等待实际获准任务到达 Worker。`d92ff98` 让配置回读用例按 PostgreSQL 队列的可执行时间有界等待。最后一次 PostgreSQL 回归和托管 OCI 共同验证源码指纹 `f5498166a2d043c0d89b1d9b3cb9c0ad57c7f3526e046d112be197ea3a00b068`。 [固定数据库用例](https://github.com/MaLaNg116/itervane/blob/d92ff9899d05d250cc7d3c611e4b0882887194c9/packages/control-plane/test/integration/inspections.test.ts)

独立原生 Komodo 适配器检查已通过。首次使用真实 Runner 制品的中断试验停在已知更新路径，旧夹具第一次 tick 回收租约时即要求拿到延时任务。`c621ac7` 接续实际入队的唤醒，空闲期间核对零重复写入。 [原生 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/44938461015) · [首轮托管 Runner](https://github.com/MaLaNg116/itervane/actions/runs/44938461019)

托管 OCI 复跑核对同一候选、人工决定、Registry 操作及容器实际版本。原先的 Registry 回读 fence 为 9。配置写入、配置回读、派发与已记录更新回读分别使用 11、12、13、14，运行镜像的 manifest 与配置摘要匹配第二代获批归档。从另一份获批归档派发且丢失原生更新 ID 的独立操作保留环境占用并转人工。两条路径均发生一次配置、一次派发，证据与实际归档、容器身份对齐，两个暂存区均已清理。标准构建与缺包回归通过。独立 Runner 回归在既有崩溃恢复结算处失败，使用同一提交单独重跑。生产入口依赖 E-D 的实际运行版本、访问保护和健康核验。 [OCI 和回归](https://github.com/MaLaNg116/itervane/actions/runs/44940682806) · [PR #52](https://github.com/MaLaNg116/itervane/pull/52)

同版第二次尝试通过旧有崩溃恢复回归，确认五个不同的原生域、恢复租约递增、HTTP/MCP 一致和暂存清理。核对回归、OCI 与 PostgreSQL 的源码指纹一致后，按固定 PR 版本复核合入 main。 [Runner 第二次尝试](https://github.com/MaLaNg116/itervane/actions/runs/44940682806/attempts/2) · [合入提交](https://github.com/MaLaNg116/itervane/commit/48ec8322422c0ec6635ab2ec1bf6c34ed3c693f0)
