# P3-C2b1 · 处置准入与发布互斥导读

本批基于 #87 的原生重启协议，固定代码为 `2971079d3f13b3b1331e6f3a519358f519633334`。 [PR #88](https://github.com/MaLaNg116/itervane/pull/88) · [分批计划](../plans/p3-c-operations-execution-admission.md)

1. `a523fc2` 新增 `operations_executions`。提案及确认版本决定操作身份。唯一约束限制每个提案一条记录，活动状态下的部分唯一索引限制同一环境一个处置。数据库校验批准、目标配置、已发布版本和授权，并保留已经关闭的记录。 [迁移与触发器](https://github.com/MaLaNg116/itervane/blob/2971079d3f13b3b1331e6f3a519358f519633334/packages/control-plane/migrations/0046_operations_execution_admission.sql)
2. `0638a42` 的准入入口锁定诊断任务和对应环境。再读当下的批准、批准者及提出者权限，并按现存证据复算原提案。重复请求经过同一组检查后才复用已有记录。 [执行准入](https://github.com/MaLaNg116/itervane/blob/2971079d3f13b3b1331e6f3a519358f519633334/packages/control-plane/src/service/operations-execution-admission.ts)
3. 发布确认在同一环境行锁下评估期限和占用，处置准入也核对该环境是否有排队、派发或核对中的发布。撤销通过数据库触发器与处置关闭同事务提交。后续准入核对数据库时间，回收已经过期且仍在预留阶段的记录。 [环境检查](https://github.com/MaLaNg116/itervane/blob/2971079d3f13b3b1331e6f3a519358f519633334/packages/control-plane/src/service/environment-effects.ts) · [发布入队](https://github.com/MaLaNg116/itervane/blob/2971079d3f13b3b1331e6f3a519358f519633334/packages/control-plane/src/runtime/release-queue.ts) · [正式发布确认](https://github.com/MaLaNg116/itervane/blob/2971079d3f13b3b1331e6f3a519358f519633334/packages/control-plane/src/service/formal-release.ts)
4. `2971079` 用真实 PostgreSQL 验证两个准入顺序、并发竞争、单提案去重、伪造记录拒绝、目标及授权变化，并注入处置关闭失败验证撤销事务回滚。指定版本恢复的预留沿用实际已核验的不同镜像。 [集成场景](https://github.com/MaLaNg116/itervane/blob/2971079d3f13b3b1331e6f3a519358f519633334/packages/control-plane/test/integration/inspections.test.ts)

本机 TypeScript、229 项单元和七项 PostgreSQL 17.12 准入专项通过。Drizzle 确认迁移快照一致。完整工作流真库回归与托管验证已启动。 [常规 CI](https://github.com/MaLaNg116/itervane/actions/runs/44986637647) · [Runner 回归](https://github.com/MaLaNg116/itervane/actions/runs/44986630788)

首轮长时间真库回归发现整套用例共用的测试身份在五分钟后过期，`145fa19` 调整为每项用例独立签发。托管回归又定位到两处夹具断言，`42641b8` 让数据库互斥用例先登记有效发布审批，并校验并发决定所返回的任务 ID。修订后五项 PostgreSQL 专项通过，覆盖原生触发器拒绝、两种顺序、并发争用及指定回滚版本。 [托管失败证据](https://github.com/MaLaNg116/itervane/actions/runs/44987168219/job/137100217818) · [修订后的用例](https://github.com/MaLaNg116/itervane/blob/42641b8eb2af2f0382eebd1da7308d16dd53dc51/packages/control-plane/test/integration/inspections.test.ts)

修订后的版本 `1b940650e36cd4f7ba7257a3e91659880fc730ab` 完成托管回归，235 项单元和 219 项 PostgreSQL 17 集成测试通过，门户和扫描器检查也通过。 [完整托管验证](https://github.com/MaLaNg116/itervane/actions/runs/44988025701) · [真库验收](https://github.com/MaLaNg116/itervane/actions/runs/44988025701/job/137102769641)

C2b2 将预留对应到持久化任务和全局执行槽，审查租约、重新领取及撤销竞态。原生派发及恢复健康在后续批次实测，现阶段的 `reserved` 只代表通过准入。
