# P3-C2b2a · 运维处置事务入队导读

本批接续 #88 的处置准入。固定实现和测试为 `9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d`，验收范围到待派发任务入队和关闭。 [PR #89](https://github.com/MaLaNg116/itervane/pull/89) · [分批计划](../plans/p3-c-operations-execution-lease.md)

1. `bd0d208` 建立处置、任务、运行和队列唤醒的持久化绑定。写入时核对批准版本、来源、任务状态和有效期。处置关闭时，延迟约束在事务提交前核对任务和运行已进入匹配状态，队列指针已清除。 [绑定和关闭约束](https://github.com/MaLaNg116/itervane/blob/9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d/packages/control-plane/migrations/0047_operations_execution_schedule.sql)
2. `687133d` 在环境行锁下重新核对提案、批准及当前映射。准入、独立任务、首个双语事件和 pg-boss 唤醒共用一个事务。重复请求复用原绑定。原诊断的证据和结算仍可查询。 [处置准入](https://github.com/MaLaNg116/itervane/blob/9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d/packages/control-plane/src/service/operations-execution-admission.ts) · [队列与关闭](https://github.com/MaLaNg116/itervane/blob/9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d/packages/control-plane/src/runtime/operations-execution-queue.ts)
3. 撤销和过期分别以取消及转人工结算，包含已被取走的唤醒。一般任务调度依据持久化绑定跳过处置任务。后续批次由专用领取流程接上全局执行槽、租约和发送意图。 [撤销处理](https://github.com/MaLaNg116/itervane/blob/9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d/packages/control-plane/src/service/operations-decisions.ts) · [调度协调](https://github.com/MaLaNg116/itervane/blob/9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d/packages/control-plane/src/runtime/coordinator.ts)
4. `e1bfe23` 用真实数据库验证入队回滚、重复提交、撤销竞态、直接写入约束、关闭回滚、预留过期及指定版本恢复的绑定。故障注入发生在 pg-boss 写入之后，专项核对队列、任务和处置一起回滚。 [真库用例](https://github.com/MaLaNg116/itervane/blob/9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d/packages/control-plane/test/integration/inspections.test.ts#L2851)
5. 真库回归发现宿主时间回调期间，诊断取证时间可能早于预留时间。`9a0dcd9` 取数据库当前时间与预留时间中较晚的值。专项用例在修复前复现约束拒绝，修复后通过，保留原有取证权限与顺序校验。 [诊断取证](https://github.com/MaLaNg116/itervane/blob/9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d/packages/control-plane/src/runtime/operations-evidence-store.ts) · [时间回归用例](https://github.com/MaLaNg116/itervane/blob/9a0dcd9ee0cd0f675aa0a22b669b0d3b58071e0d/packages/control-plane/test/integration/inspections.test.ts#L3300)

固定版本通过 TypeScript、229 项本机单元测试、11 项 PostgreSQL 17.12 专项及 Drizzle 迁移一致性。专项包含发布互斥的三种顺序及诊断取证回归。本批的正式入口仍以人工决定记录为终点。专用任务领取和恢复接管在 C2b2b 交付，Whiskers 原生派发与健康结算在 C2c 验收。 [托管检查](https://github.com/MaLaNg116/itervane/pull/89/checks)

#89 合入前复核版本为 `c6faba8207d893a0c8dbe7a09707098dc13777b6`。17 项托管检查通过。受保护应用报告指纹为 `a243678b69967792cf9dab9fa7e8f41156901e1fabf71d87cc153e104260540c`，核对同一发布目标、诊断四类证据、HTTP 与 MCP 回执一致、一次发布派发及执行槽释放。合入提交为 `b121e031d860d2a120bbce2675e37690361e1676`。 [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45006596278) · [合入记录](https://github.com/MaLaNg116/itervane/pull/89)
