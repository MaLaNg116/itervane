# P2-E-C3-C2 · Registry 导入与进程中断恢复

基于归档步骤和唯一导入意图。 [PR #48](https://github.com/MaLaNg116/itervane/pull/48) · [恢复计划](../plans/p2-e-formal-release-registry-recovery.md)

1. `84b2751` 让正式发布在提交 Registry 导入意图之后携带待核对唤醒。租约过期时，操作 ID、冻结候选和目标环境占用随事务保留。普通源码队列仍按原执行权认领。 [恢复迁移](https://github.com/MaLaNg116/itervane/blob/84b2751/packages/control-plane/migrations/0033_formal_release_registry_recovery.sql)
2. `a53732b` 在新 fence 上领取只读核对。原写入授权只在初次认领且唯一意图已提交时成立。已发出的操作仍可核对实际结果，找到匹配制品后记录原写入和新观察的 fence，并按已经请求的取消完成结算。缺失、错配或查询失败时，至多进行三次自动核对。认领与事件同事务记录，崩溃也计入上限。 [发布执行权](https://github.com/MaLaNg116/itervane/blob/a53732b/packages/control-plane/src/runtime/formal-release-claim.ts) · [结果持久化](https://github.com/MaLaNg116/itervane/blob/a53732b/packages/control-plane/src/runtime/formal-release-steps.ts)
3. `4e50be2` 通过正式 Worker 先读取并核验批准归档，再提交唯一导入意图并调用固定 Registry。初次导入有执行权和审批复核。恢复路径只以登记来源、仓库和固定摘要调用适配器的独立核对接口。 [Worker](https://github.com/MaLaNg116/itervane/blob/4e50be2/packages/control-plane/src/runtime/formal-release-worker.ts)
4. `9e882c4` 在真实 PostgreSQL 覆盖重叠认领、原授权在等结果期间被撤销、只读认领、错误 Registry 来源、实际结果缺失或错配、取消和上限后的环境占用。 [集成用例](https://github.com/MaLaNg116/itervane/blob/9e882c4/packages/control-plane/test/integration/inspections.test.ts)
5. `8624abd` 在托管 KVM 探针上使用正式 Worker 导入。父进程在实际导入且私有暂存清理之后、结果尚未写入 PostgreSQL 时终止原进程，等数据库租约实际过期后启动新进程。验收核对同一操作、唯一导入意图、已验证镜像摘要和新观察 fence。 [原生进程探针](https://github.com/MaLaNg116/itervane/blob/8624abd/packages/control-plane/test/native/release-recovery.ts) · [证据比对](https://github.com/MaLaNg116/itervane/blob/8624abd/packages/control-plane/test/native/worker-inspection.ts)

固定源码 `8624abdac5b6eed9e676843fcbbf16fb9ad20cca`。TypeScript、163 项单元和原生 Worker 打包通过。PostgreSQL 17.12 的三项恢复专项及 151 项全量集成测试通过，源码指纹为 `7d8f03f3cc32195ed2dc15196aad87436ff58440bcfcb9490aa5fcc72c94cf7f`。托管源码 `69499d2a8b182e416e36fb097c39f3cdcbee770d` 的差异限于文档。 [PR #49](https://github.com/MaLaNg116/itervane/pull/49) · [托管 KVM 验收](https://github.com/MaLaNg116/itervane/actions/runs/44931283197)

四组托管 Runner 和常规 CI 均通过。回读产物报告中的操作与审批、归档传输及 Registry 记录一致。原导入 fence 为 8，新观察 fence 为 9，共一条导入意图和一次只读认领。实际回读的 manifest、镜像配置及 79,042,560 字节归档摘要一致，进程中断前已清理暂存。复核的交付版本 `01df94c19d958e95ea67f1dc191c3469864a70c5` 已合入主分支。 [合并提交](https://github.com/MaLaNg116/itervane/commit/7b20eb5aaec7b9292fe9055eaad5c9aa096653d5)

C4 在已确认的同摘要 Registry 制品上接续真实 Komodo 派发。E-D 独立核对线上镜像、配置和健康后完成 P2 验收。
