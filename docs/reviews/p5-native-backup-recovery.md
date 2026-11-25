# P5-A2 · 原生发布与运维记录的冷备演练

本批复用可自托管冷备命令，在现有托管 KVM 的受保护发布及原生运维作业中恢复真实数据。 [本批计划](../plans/p5-native-backup-recovery.md) · [#160](https://github.com/MaLaNg116/itervane/pull/160)

1. `7c66ba9` 在成功发布、两次受控恢复和一次回执中断后关闭 API 及临时数据库连接。备份作业仅复制库中指名的内容寻址档案，同时选择三个原生重启安装配置。 [原生场景](https://github.com/MaLaNg116/itervane/blob/7c66ba9/packages/control-plane/test/native/worker-inspection.ts) · [备份演练](https://github.com/MaLaNg116/itervane/blob/7c66ba9/packages/control-plane/test/native/backup-proof.ts)
2. 独立 PostgreSQL 恢复后核对同一发布、复验摘要、成功重启、回执未知的环境占用和已审核 Runbook 引用。恢复后的档案由独立 OCI 元数据读取器检查，配置按字节比对。治理服务关闭前后的应用身份保护由入口真实响应验证。 [托管判据](https://github.com/MaLaNg116/itervane/blob/7c66ba9/.github/workflows/native-runner.yml)
3. 托管作业记录重启验收停在哪一步。阶段覆盖基线读取、门户批准、原生请求与批准、继续执行、读回和核对日志，保留原有判据和数据脱敏。

本地 TypeScript、原生入口打包及两套 PostgreSQL 17.12 的基础备份演练已通过。真实 KVM 档案、外部部署、身份和运维记录的备份复原由本批托管作业验证。验收报告仅保留摘要和判据，数据库备份与档案留在临时环境。回执中断的操作继续待核对。 [基础冷备导读](p5-backup-restore.md)
