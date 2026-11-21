# P2-E-D3-A · 上线核验租约导读

基于 [自托管入口 #55](https://github.com/MaLaNg116/itervane/pull/55)。本批给已经派发且记录终态更新的发布操作签发独立只读租约。固定代码 `d10ab2ca07874210f70cebba063cd91f28d94440`。 [分批计划](../plans/p2-e-rollout-settlement.md)

1. `0475b05` 新建核验账本。每次认领增加一次 fence，租约最多 45 秒，单操作最多三次。PostgreSQL 部分唯一索引确保全局只有一个观察者，触发器用数据库时钟校验认领时限、不可变历史和原生派发前置记录。 [数据库迁移](https://github.com/MaLaNg116/itervane/blob/0475b0530da6a657cbb84985f55c969596e6b4c9/packages/control-plane/migrations/0036_formal_release_rollout_attempts.sql)
2. `064a7cc` 先锁任务及其环境操作，再核对代次、冻结候选、目标修订、人工确认、Registry 证据和已记录的 Komodo 更新。认领有独立调度锁，观察不占模型工作流的单执行槽。只读取证允许在派发后的取消或撤权发生后继续核对既成结果。第三次超时转人工并保留环境占用。认领和转人工事件都有中英文消息。 [认领协调器](https://github.com/MaLaNg116/itervane/blob/064a7cc540e9395e9c08a9a9c4d110cbc4709bc7/packages/control-plane/src/runtime/formal-rollout-claim.ts)
3. `d10ab2c` 通过正常冻结、人工确认、制品导入与 Komodo 派发账本把操作推进到待核验。用两个并发事务核验只有一个租约获签，验证接手后旧 fence 失效、撤权后禁止继续写入，并用直接 SQL 回归确认越阶段认领、超时限或删除历史被拒绝。 [真实 PostgreSQL 专项](https://github.com/MaLaNg116/itervane/blob/d10ab2ca07874210f70cebba063cd91f28d94440/packages/control-plane/test/integration/inspections.test.ts)

固定代码通过 TypeScript 和 200 项单元测试。Linux 上真实 PostgreSQL 17.12 通过三项租约专项和 164 项全量集成测试，报告 `.reports/p0/database.json` 的源码指纹为 `50ebeb2229dcd2caf8025d65bafc63e4c0910a332d9727c4ac7617a3c1024316`。从仓库运行 `pnpm check` 与 `pnpm probe:p0 database` 可复核。 [实施计划](../implementation-plan-v2-ts-postgresql.md)

最终证据入账由 D3-B 交付。正式 Worker 和双语结果读取由 D3-C 接续。同一获批 OCI 从外部 MCP 发起到受保护入口的真实端到端验收在 D3-D。
