# P5-A1 · 控制面冷备与独立恢复

本批给维护者提供数据库及所引用档案的冷备与恢复命令。独立恢复数据库和文件目录后保留核对结果，维护者依据下游当前状态决定何时连接写入 Worker。 [计划](../plans/p5-backup-restore.md) · [中英文操作说明](../control-plane-backup.md) · [#159](https://github.com/MaLaNg116/itervane/pull/159)

1. `7b66719` 使用 PostgreSQL 17 客户端检查库已停止应用连接，导出控制面、迁移、队列和检查点四个 schema。导出前后核对表清单，保留验证收据及发布候选所引用的 OCI 档案，逐文件保存大小和摘要。 [PostgreSQL 实现](https://github.com/MaLaNg116/itervane/blob/7b66719/packages/control-plane/src/persistence/backup-postgres.ts) · [文件处理](https://github.com/MaLaNg116/itervane/blob/7b66719/packages/control-plane/src/persistence/backup.ts)
2. 同一提交要求恢复目标为空。复制并校验文件后才开始 `pg_restore` 单事务。恢复后核对表及 OCI 引用，写入回执。目标环境管理员独立配置下游凭证和运行角色，核对旧批准、未完成操作和当前部署。 [命令入口](https://github.com/MaLaNg116/itervane/blob/7b66719/packages/control-plane/src/entries/backup.ts)
3. `b95d484` 在两个独立 PostgreSQL 17.12 临时实例实做备份和恢复。通过签名身份导入、审核并发布一条设计 Skill，按实际任务流程留下暂停检查点和待处理队列。恢复后用新授予的运行账号读回原任务、事件、规则版本和队列，随后用应用服务取消该排队任务。源库有连接、损坏备份和目标非空均被拒绝。 [真库演练](https://github.com/MaLaNg116/itervane/blob/b95d484/packages/control-plane/test/native/backup.ts)

本机 `pnpm check` 通过 TypeScript 与 287 项单测。 `pnpm probe:backup` 恢复了 89 张表和一份非凭证配置，数据库归档 616333 字节，清单摘要为 `42178e7e3faf06644e25d68071804e6b5fea26a00920167d62ee20e7d956062e`。本地演练没有原生 OCI 档案。后续批次在托管 KVM 的真实发布与运维记录上验证档案、受保护入口和恢复后的历史。 [PostgreSQL 恢复行为](https://www.postgresql.org/docs/17/app-pgrestore.html)
