# P3-A2-B1 · Whiskers 运维后端登记导读

依赖 [已发布运维目标 #67](https://github.com/MaLaNg116/itervane/pull/67)。数据库版本 `dc02046e26cdc98836c37ed1fa1e749b64fccac4`，入口版本 `76da34c5a3dc4fc45937cb2c3df3661c631ad977`。 [分批计划](../plans/p3-a-whiskers-enrollment.md)

1. `0038` 增加 `operations_targets`。外键绑定正式发布登记和同一项目、应用及环境。登记文档固定 Whiskers 地址与服务器 ID，保存正式发布登记的代次与摘要。地址与观察适配器共用约束。 [迁移](https://github.com/MaLaNg116/itervane/blob/dc02046e26cdc98836c37ed1fa1e749b64fccac4/packages/control-plane/migrations/0038_operations_targets.sql) · [输入契约](https://github.com/MaLaNg116/itervane/blob/dc02046e26cdc98836c37ed1fa1e749b64fccac4/packages/contracts/src/operations.ts)
2. 维护者执行 `pnpm register:operations-target <配置文件>`。输入包含 `environmentId`、`releaseTargetRevision`、`releaseTargetSha256` 和 `whiskers`。`whiskers` 包含 `origin` 与 `serverId`。输出环境、当前登记代次和指纹。事务锁定环境，重复登记返回同一代次，配置更新生成新代次。Worker 单独获得 Read 密钥。 [安装命令](https://github.com/MaLaNg116/itervane/blob/76da34c5a3dc4fc45937cb2c3df3661c631ad977/packages/control-plane/src/entries/register-operations-target.ts) · [持久化及读取](https://github.com/MaLaNg116/itervane/blob/76da34c5a3dc4fc45937cb2c3df3661c631ad977/packages/control-plane/src/service/operations-targets.ts)
3. 连接资料与同一项目的当前正式发布合并后才供诊断使用。集成测试覆盖没有登记、拒绝额外凭证输入、并发登记幂等、切换服务器、另一项目不可见和发布登记换代。 [集成用例](https://github.com/MaLaNg116/itervane/blob/76da34c5a3dc4fc45937cb2c3df3661c631ad977/packages/control-plane/test/integration/inspections.test.ts)

本机 TypeScript、210 项单元及 Drizzle 迁移一致性通过。托管 PostgreSQL 与原生接续待归档。后续诊断任务固定登记指纹、走可恢复队列并复核授权。
