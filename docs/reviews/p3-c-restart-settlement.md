# P3-C2c3b2 · 独立重启结算导读

本批接续 #98 的停止快照。代码快照为 `253809378b188951651180666ca6eff9b87d0b95`。 [PR #99](https://github.com/MaLaNg116/itervane/pull/99) · [结算计划](../plans/p3-c-restart-settlement.md)

1. `d4ec7bc` 按处置和次数保留核对账本。事务检查活跃 fence、原生续发应答、冻结发布和停止锚点。完成记录与任务事件、占用状态和调度变化一起提交。环境释放使用数据库保存的完成时刻。 [迁移](https://github.com/MaLaNg116/itervane/blob/253809378b188951651180666ca6eff9b87d0b95/packages/control-plane/migrations/0056_operations_restart_recovery_receipts.sql)
2. `62465a2` 在原意图之后取得独立核对租约。每次外部读取仍核对登记、原发布和 fence，平台批准撤销后可读取同一原操作的效果。原生许可未知时保留可用健康证据并转人工。网络暂不可用、健康未恢复或租约到期最多核对三次。 [结算服务](https://github.com/MaLaNg116/itervane/blob/253809378b188951651180666ca6eff9b87d0b95/packages/control-plane/src/runtime/operations-restart-recovery.ts) · [只读执行器](https://github.com/MaLaNg116/itervane/blob/253809378b188951651180666ca6eff9b87d0b95/packages/control-plane/src/runtime/operations-restart-recovery-worker.ts)
3. `2538093` 覆盖撤权后的成功核对、原生未知时拒绝直接释放、登记漂移、旧资料缺失、过期 fence、有限重领以及事件写入失败的原子回滚。成功后同一环境可接收发布。 [真库测试](https://github.com/MaLaNg116/itervane/blob/253809378b188951651180666ca6eff9b87d0b95/packages/control-plane/test/integration/inspections.test.ts)

## 验收与接续

TypeScript、244 项单元、PostgreSQL 17.12 九项专项和 Drizzle 迁移一致性通过。真库使用限定的外部证据夹具，验证审批、围栏、持久化和队列行为。中英文任务结算事件使用同一真库记录。 [托管检查](https://github.com/MaLaNg116/itervane/pull/99/checks) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/45006369277)

C2c3c 将专用 Writer、只读健康身份、平台人审与原生 Operator 接入实际安装，交付有授权的回执查询，并在同一个已发布标准应用完成真实审批、一次重启及独立恢复验收。
