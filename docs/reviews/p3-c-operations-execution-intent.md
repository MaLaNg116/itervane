# P3-C2b2b · 运维处置租约与发送意图导读

本批接续 #89 的处置入队。交付代码与测试固定在 `bf11e12898948a5fe2a53e558c40fff8360133d4`。 [PR #90](https://github.com/MaLaNg116/itervane/pull/90) · [实施计划](../plans/p3-c-operations-execution-lease.md)

1. `9104174` 固定每条处置的唯一发送意图。数据库核对运行代次、fence、Worker、批准版本和提案指纹，也检查当前授权、环境与发布绑定。批准撤销可以关闭发送前的处置。已有意图时，环境占用保留，等待实际结果核对。 [意图与撤销约束](https://github.com/MaLaNg116/itervane/blob/bf11e12898948a5fe2a53e558c40fff8360133d4/packages/control-plane/migrations/0048_operations_execution_intent.sql#L55)
2. `f655e40` 复用全局执行槽。领取校验已登记环境和唤醒绑定，重新核对批准及授权，然后在同一事务完成队列唤醒、分配租约和追加事件。执行槽繁忙时留下一个新唤醒，处理遗失唤醒也使用同一绑定。 [领取](https://github.com/MaLaNg116/itervane/blob/bf11e12898948a5fe2a53e558c40fff8360133d4/packages/control-plane/src/runtime/operations-execution-lease.ts#L84) · [批准核对](https://github.com/MaLaNg116/itervane/blob/bf11e12898948a5fe2a53e558c40fff8360133d4/packages/control-plane/src/service/operations-execution-admission.ts#L31)
3. 发送意图与事件原子提交。意图写入前丢失租约时可以重新领取。写入后失去执行权时，后继 Worker 只能领取结果核对任务，原执行者无法续约或写入。中英文任务事件都保留运行状态与处置原因。 [发送意图](https://github.com/MaLaNg116/itervane/blob/bf11e12898948a5fe2a53e558c40fff8360133d4/packages/control-plane/src/runtime/operations-execution-lease.ts#L137) · [接管](https://github.com/MaLaNg116/itervane/blob/bf11e12898948a5fe2a53e558c40fff8360133d4/packages/control-plane/src/runtime/operations-execution-lease.ts#L51)
4. `bf11e12` 覆盖共用执行槽、丢失唤醒、无效旧代次、意图事件写入失败、重复登记、并发撤销、换绑与授权变化。期限用例比较了预留、排队、领取和已有意图四种状态下的发布互斥。 [领取与接管真库用例](https://github.com/MaLaNg116/itervane/blob/bf11e12898948a5fe2a53e558c40fff8360133d4/packages/control-plane/test/integration/inspections.test.ts#L2869) · [期限用例](https://github.com/MaLaNg116/itervane/blob/bf11e12898948a5fe2a53e558c40fff8360133d4/packages/control-plane/test/integration/inspections.test.ts#L3210)

本机 TypeScript、229 项单元测试、18 项 PostgreSQL 17.12 专项及 Drizzle 迁移一致性通过。领取和接管八项在同一组运行通过。入队、互斥和到期十项中，排队到期用例初次遇到发布夹具的数据库时钟回拨，单项复跑通过，时序问题另行修订。实际 Whiskers 写入、下游人工批准回执及独立健康核验由 C2c 接入。 [托管检查](https://github.com/MaLaNg116/itervane/pull/90/checks)
