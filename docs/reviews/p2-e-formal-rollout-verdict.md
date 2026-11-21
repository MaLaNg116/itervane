# P2-E-D3-B · 正式上线结算导读

接续 [上线核验租约 #56](https://github.com/MaLaNg116/itervane/pull/56)。固定代码与测试 `49c190f02181568303ce8bb9b1fb72c314c259ae`。 [分批计划](../plans/p2-e-formal-rollout-verdict.md)

1. `d463d79` 将结论追加到当前核验尝试。数据库把证据与冻结指纹、同一决定、目标修订、获批镜像和记录的 Komodo 更新逐项对照。成功证据、`verified_formal`、任务和审计事件必须在同一事务提交。失败结论只存受控原因码并继续保留环境占用。 [迁移](https://github.com/MaLaNg116/itervane/blob/d463d79/packages/control-plane/migrations/0037_formal_release_rollout_verdict.sql) · [证据契约](https://github.com/MaLaNg116/itervane/blob/d463d79/packages/contracts/src/release.ts)
2. `80eed68` 调用读适配器，在核验实际容器及入口前后都读取同一条 Komodo 更新。每一步外部读操作重新验证租约。成功记录保留已发生的发布结果，派发后取消的任务以已取消状态结算。兼容既有样例的 `verified_fixture`。 [只读 Worker](https://github.com/MaLaNg116/itervane/blob/80eed68/packages/control-plane/src/runtime/formal-rollout-worker.ts) · [结算事务](https://github.com/MaLaNg116/itervane/blob/80eed68/packages/control-plane/src/runtime/formal-rollout-claim.ts)
3. `49c190f` 复用已派发正式候选的事务夹具。新专项包含两个 Worker 竞争、错操作与镜像、部分事务回滚、旧 fence、派发后取消、下游更新变化和受保护健康失败。逐项核对发布状态、环境占用与双语事件。真实下游读适配调用由可控夹具提供。 [PostgreSQL 集成测试](https://github.com/MaLaNg116/itervane/blob/49c190f02181568303ce8bb9b1fb72c314c259ae/packages/control-plane/test/integration/inspections.test.ts)

固定代码通过 TypeScript、200 项单元和 PostgreSQL 17.12 的八项上线核验专项。全量数据库和托管回归待归档。D3-C 接续自托管 Worker 安装与双语查询，D3-D 验收同一正式操作的真实端到端发布。
