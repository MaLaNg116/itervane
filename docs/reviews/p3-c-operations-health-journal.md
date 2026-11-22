# P3-C3-A1 · 健康事件账本导读

本批接续 #120，固定代码和测试为 `e5a9bd4c4e176062281a69de49fb20d47f13c28a`。 [阶段计划](../plans/p3-c-operations-incidents.md) · [PR #121](https://github.com/MaLaNg116/itervane/pull/121)

1. 探针开始时从 PostgreSQL 取得顺序号与时间，冻结当前受保护发布、容器和登记。若当前实例来自恢复，同一镜像的绑定还包含恢复执行及新的核验摘要。真正读取在事务外进行。 [实例绑定和准备](https://github.com/MaLaNg116/itervane/blob/e5a9bd4c4e176062281a69de49fb20d47f13c28a/packages/control-plane/src/service/operations-health.ts#L24)
2. 记录时锁住环境并重读当前登记与发布。待派发或待核对的环境暂停记录。同一探针和结果复用回执，结果不一致或乱序时拒绝更新。一次事务提交样本和事件，样本不可改写，外键限制同一事件的样本作用域。 [落库与去重](https://github.com/MaLaNg116/itervane/blob/e5a9bd4c4e176062281a69de49fb20d47f13c28a/packages/control-plane/src/service/operations-health.ts#L42) · [迁移](https://github.com/MaLaNg116/itervane/blob/e5a9bd4c4e176062281a69de49fb20d47f13c28a/packages/control-plane/migrations/0062_operations_health_incidents.sql)
3. 每个环境最多有一条开放事件。同一实例的异常增加样本数，确认恢复才关闭该事件。探针不可用保留已有状态，确认新的目标后以目标变化结束旧事件。历史样本继续关联原来绑定。 [事件状态](https://github.com/MaLaNg116/itervane/blob/e5a9bd4c4e176062281a69de49fb20d47f13c28a/packages/control-plane/src/service/operations-health.ts#L102)

TypeScript、249 项单元、三个 PostgreSQL 17.12 专项及 Drizzle 迁移一致性通过。真库验证并发重复、乱序、不可改写、事务回滚、发布切换、登记变化和同一镜像恢复后的新实例。样本来自受信测试夹具，原生健康读取和诊断调度分别由 C3-A2 与 C3-B 接续。 [真库断言](https://github.com/MaLaNg116/itervane/blob/e5a9bd4c4e176062281a69de49fb20d47f13c28a/packages/control-plane/test/integration/inspections.test.ts#L2157) · [托管检查](https://github.com/MaLaNg116/itervane/pull/121/checks)
