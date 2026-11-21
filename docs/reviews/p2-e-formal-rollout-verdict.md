# P2-E-D3-B · 正式上线结算导读

接续 [上线核验租约 #56](https://github.com/MaLaNg116/itervane/pull/56)。固定代码与测试 `49c190f02181568303ce8bb9b1fb72c314c259ae`。 [分批计划](../plans/p2-e-formal-rollout-verdict.md)

1. `d463d79` 将结论追加到当前核验尝试。数据库把证据与冻结指纹、同一决定、目标修订、获批镜像和记录的 Komodo 更新逐项对照。成功证据、`verified_formal`、任务和审计事件必须在同一事务提交。失败结论只存受控原因码并继续保留环境占用。 [迁移](https://github.com/MaLaNg116/itervane/blob/d463d79/packages/control-plane/migrations/0037_formal_release_rollout_verdict.sql) · [证据契约](https://github.com/MaLaNg116/itervane/blob/d463d79/packages/contracts/src/release.ts)
2. `80eed68` 调用读适配器，在核验实际容器及入口前后都读取同一条 Komodo 更新。每一步外部读操作重新验证租约。成功记录保留已发生的发布结果，派发后取消的任务以已取消状态结算。兼容既有样例的 `verified_fixture`。 [只读 Worker](https://github.com/MaLaNg116/itervane/blob/80eed68/packages/control-plane/src/runtime/formal-rollout-worker.ts) · [结算事务](https://github.com/MaLaNg116/itervane/blob/80eed68/packages/control-plane/src/runtime/formal-rollout-claim.ts)
3. `49c190f` 复用已派发正式候选的事务夹具。新专项包含两个 Worker 竞争、错操作与镜像、部分事务回滚、旧 fence、派发后取消、下游更新变化和受保护健康失败。用可控的下游响应逐项核对真实数据库中的发布状态、环境占用与双语事件。 [PostgreSQL 集成测试](https://github.com/MaLaNg116/itervane/blob/49c190f02181568303ce8bb9b1fb72c314c259ae/packages/control-plane/test/integration/inspections.test.ts)

固定代码通过 TypeScript、200 项单元、真实 PostgreSQL 17.12 八项上线核验专项和 169 项全量集成测试。运行 `pnpm check` 与 `pnpm test:integration` 可复核。数据库报告 `.reports/p0/database.json` 源码指纹 `1e7760c77d4115a647d6d35a2dcacc2a5c37c6191bf7b44f88daa2e7ca269f30`。

同一源码通过原生 Komodo、受保护入口及四组托管 KVM 回归。Runner 报告匹配 PostgreSQL 验收的源码指纹，复测观察到五个临时域和 fence 从 4 续领为 5。保留了已知原生更新的恢复及更新编号丢失时转人工的证据。 [PR #57](https://github.com/MaLaNg116/itervane/pull/57) · [原生 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/44949166614) · [入口回归](https://github.com/MaLaNg116/itervane/actions/runs/44949166620) · [托管 Runner](https://github.com/MaLaNg116/itervane/actions/runs/44949166607)

合入审查复核了 PostgreSQL 事务约束、过期租约、保留人工审批身份和派发后取消的语义。审查版本 `e3cc561d7fb39725cc757f9d0d84d3292148a410` 的产品源码与验收一致，两组常规检查通过。已合入 `1e01a345fff98f6a00e0d53f4221ccd25aa94290`。D3-C 接续 Worker 安装与双语查询，D3-D 验收同一操作的真实发布。 [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44951490892) · [分支 CI](https://github.com/MaLaNg116/itervane/actions/runs/44951488160)
