# P5-C2 · 参考安装升级导读

使用实际 PostgreSQL 17、Keycloak 26.8.2、Chrome 与外部 MCP，在历史控制面创建一条未运行任务，再以当前参考命令继续使用同一个安装。 [本批计划](../plans/p5-reference-upgrade.md) · [前置 #170](https://github.com/MaLaNg116/itervane/pull/170)

1. `b2b8b24` 加载固定 Git 基线 `50fe5b1` 的迁移和领域服务。历史身份验证器校验当次 Keycloak 令牌，沿用旧版 owner 初始化、项目登记、仓库登记和事务入队。核对旧队列的任务、运行代次与队列标识。 [历史数据准备](https://github.com/MaLaNg116/itervane/blob/b2b8b24/packages/control-plane/test/native/reference-upgrade.ts)
2. `b2b8b24` 对同一安装执行两次 `reference:init`，比对完整迁移账本及旧版前缀，验证原 owner、任务、队列任务及数据库角色。升后 Worker 消费同一个任务并进入 Runner 闸门，经过真实登录的双语门户以及外部 MCP 继续读回。再次用相同幂等键提交只返回原任务。 [升级与读回](https://github.com/MaLaNg116/itervane/blob/b2b8b24/packages/portal/test/native/reference-install.ts)
3. `bb1081d` 固定旧版源码与依赖，并由托管任务保留绑定当前代码树的脱敏摘要。`070dc2a` 记录升级前冷备、完成数据迁移、启用进程和故障恢复步骤。 [托管验收](https://github.com/MaLaNg116/itervane/blob/bb1081d/.github/workflows/verification.yml) · [安装与升级](../reference-installation.md#升级既有参考安装)

本地用真实服务从 63 条迁移升级至 85 条。第二次初始化保留原账本、原维护者、任务和队列，迁移账本 SHA-256 为 `fac97685f0700149f5216d5fe02001cd98b0fbef308d6ccd59b46d7efa25b3ab`。严格类型与 287 项单测也通过。托管的操作系统、镜像与源码回执由本批检查记录，升级前冷备的实际数据库与 OCI 恢复另有专门演练。 [原生冷备演练](p5-native-backup-recovery.md)

`aeb8e4d` 的 Ubuntu 托管浏览器作业通过，保留的升级回执与本地迁移数和账本摘要一致。旧队列任务由升后 Worker 消费并进入 Runner 闸门，原幂等键继续返回同一任务。 [托管升级回执](https://github.com/MaLaNg116/itervane/actions/runs/45766177221/job/139727509716)
