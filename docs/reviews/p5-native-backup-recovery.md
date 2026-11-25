# P5-A2 · 原生发布与运维记录的冷备演练

本批复用可自托管冷备命令，在现有托管 KVM 的受保护发布及原生运维作业中恢复真实数据。 [本批计划](../plans/p5-native-backup-recovery.md) · [#160](https://github.com/MaLaNg116/itervane/pull/160)

1. `7c66ba9` 在成功发布、两次受控恢复和一次回执中断后关闭 API 及临时数据库连接。备份作业仅复制库中指名的内容寻址档案，同时选择三个原生重启安装配置。 [原生场景](https://github.com/MaLaNg116/itervane/blob/7c66ba9/packages/control-plane/test/native/worker-inspection.ts) · [备份演练](https://github.com/MaLaNg116/itervane/blob/7c66ba9/packages/control-plane/test/native/backup-proof.ts)
2. 独立 PostgreSQL 恢复后核对同一发布、复验摘要、成功重启、回执未知的环境占用和已审核 Runbook 引用。恢复后的档案由独立 OCI 元数据读取器检查，配置按字节比对。治理服务关闭前后的应用身份保护由入口真实响应验证。 [托管判据](https://github.com/MaLaNg116/itervane/blob/7c66ba9/.github/workflows/native-runner.yml)
3. 托管作业记录重启验收停在哪一步。阶段覆盖基线读取、门户批准、原生请求与批准、继续执行、读回和核对日志，保留原有判据和数据脱敏。

本地 TypeScript、原生入口打包及两套 PostgreSQL 17.12 的基础备份演练已通过。`faaf21b` 的托管作业在另一套 PostgreSQL 17.12 实际恢复了 89 张表、三份配置和一份 79,042,560 字节的 OCI 档案，成功恢复回执与 Runbook 引用均可读回。回执中断的操作仍为 `native_unconfirmed`，恢复前后匿名请求均返回 401。验收作业的最终检查因引用错误的报告字段失败。本批修正后用独立 OCI 报告的清理状态、字节数、档案摘要和 manifest 摘要交叉核对，已用保留产物验证原始档案通过、改写摘要后被拒绝。修正版本仍需通过托管验收。报告仅保留摘要和判据，数据库备份与档案留在临时环境。 [托管演练](https://github.com/MaLaNg116/itervane/actions/runs/45572661808/job/139063074650) · [基础冷备导读](p5-backup-restore.md)
