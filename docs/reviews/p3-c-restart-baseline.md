# P3-C2c3b1 · 重启发送前停止快照导读

本批接续 #97 的恢复核验，使用固定验收树 `153233b2b99757b60b922f8f1a1f00164aa433e8`。 [PR #98](https://github.com/MaLaNg116/itervane/pull/98) · [本批计划](../plans/p3-c-restart-baseline.md)

1. `52a73d7` 将停止快照与摘要加入原生请求。数据库按原批准冻结的容器和发布核验回执校验新记录，要求规范化启动时间与停止态。已经保存的快照随原请求保留。 [迁移](https://github.com/MaLaNg116/itervane/blob/153233b2b99757b60b922f8f1a1f00164aa433e8/packages/control-plane/migrations/0055_operations_restart_runtime_baseline.sql)
2. `66d0a6d` 在连接和发送两阶段核对批准与租约。Komodo 的前置读回使用固定发布映射。首次意图与停止快照同事务提交，续发重新读取快照并比较摘要。实例或启动时间变化时保留原生请求及环境占用，转给只读核对。 [派发 Worker](https://github.com/MaLaNg116/itervane/blob/153233b2b99757b60b922f8f1a1f00164aa433e8/packages/control-plane/src/runtime/operations-restart-worker.ts) · [请求与映射](https://github.com/MaLaNg116/itervane/blob/153233b2b99757b60b922f8f1a1f00164aa433e8/packages/control-plane/src/runtime/operations-restart-request.ts) · [执行租约](https://github.com/MaLaNg116/itervane/blob/153233b2b99757b60b922f8f1a1f00164aa433e8/packages/control-plane/src/runtime/operations-execution-lease.ts)
3. `9a3d645` 在真实 PostgreSQL 上观察工具调用前已经落库的快照、发送意图和续发状态，并验证绑定变化、不可变性和失败注入后的事务回滚。外部协议使用限定响应夹具。 [真库专项](https://github.com/MaLaNg116/itervane/blob/153233b2b99757b60b922f8f1a1f00164aa433e8/packages/control-plane/test/integration/inspections.test.ts)

## 验收与接续

TypeScript、244 项单元和 Drizzle 迁移一致性通过。首轮 PostgreSQL 17.12 专项四项通过，派发用例一度在既有准入守卫中止。该用例独立复跑通过，同步只读诊断策略后的验收树五项全部通过。 [常规检查](https://github.com/MaLaNg116/itervane/actions/runs/45004966405) · [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45004935578)

基于已合入 #97 的主分支复核 `61344c09b49730548c06eaf73a9185e2cd0918f0`。核对停止快照的数据库绑定、续发前重新授权与独立回读，16 项托管检查通过，包含九项真实 KVM 场景。已通过 `24b57bf2196ab83058d8449597b264c36b5154fb` 合入。 [最终检查](https://github.com/MaLaNg116/itervane/pull/98/checks) · [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45038504271) · [合入记录](https://github.com/MaLaNg116/itervane/commit/24b57bf2196ab83058d8449597b264c36b5154fb)

后续批次还需在独立租约中读取历史操作及原生许可状态，完成有限核对、原子结算和授权释放。实际安装与同一应用的 Whiskers 人审、派发和健康闭环由 C2c3c 验收。
