# P3-C2d2a · 指定版本恢复意图导读

依赖 #107，固定代码与测试为 `3e8ee663f5f991298a883ee12d47980d842a290f`。 [实施计划](../plans/p3-c-operations-restore.md) · [PR #108](https://github.com/MaLaNg116/itervane/pull/108)

1. 再次复核诊断和审批时，构造包含当前镜像、已批准恢复镜像、原上线版本、目标登记和 Komodo 部署的恢复计划。计划的两个镜像及回执指纹均源自正式发布账本。 [计划来源](https://github.com/MaLaNg116/itervane/blob/3e8ee663f5f991298a883ee12d47980d842a290f/packages/control-plane/src/service/operations-proposals.ts#L44)
2. 迁移 0057 扩展同一处置意图记录。数据库先复核批准、执行权和环境锁，再逐项比对目标登记、原提案和历史上线核验结果。计划与其指纹跟随意图留存，已有意图按原记录保留。 [数据库约束](https://github.com/MaLaNg116/itervane/blob/3e8ee663f5f991298a883ee12d47980d842a290f/packages/control-plane/migrations/0057_operations_restore_intents.sql#L7)
3. 准备派发时把计划、发送意图和任务事件一起提交。租约过期后从下一代次领取核对，读取原计划并重算摘要。真库用例覆盖重复发布、替换镜像与部署目标、注入事件写入失败和撤销后的只读接管。 [租约与接管](https://github.com/MaLaNg116/itervane/blob/3e8ee663f5f991298a883ee12d47980d842a290f/packages/control-plane/src/runtime/operations-execution-lease.ts#L241) · [验证场景](https://github.com/MaLaNg116/itervane/blob/3e8ee663f5f991298a883ee12d47980d842a290f/packages/control-plane/test/integration/inspections.test.ts#L2803)

TypeScript、246 项单元、七项 PostgreSQL 17.12 专项及 Drizzle 迁移一致性通过。Komodo 专用安装、配置变更与部署更新在 C2d2b 验收。 [托管检查](https://github.com/MaLaNg116/itervane/pull/108/checks)

固定托管版本 `1f2653c685f53dc8f6dbc06d99b1885a1bc5b243` 的常规检查和九组 KVM 全部通过。受保护应用正常重启得到 401／200 并释放环境。中断场景保留 `native_unconfirmed` 和环境占用，释放执行槽。HTTP／MCP 回执一致。证据源码指纹为 `f7995dbe6f32ff957141a4603afdf76bcbed2b8dd38eb4c81bb88ecb40af810a`。 [常规检查](https://github.com/MaLaNg116/itervane/actions/runs/45018291539) · [九组 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45018166747) · [原生回归产物](https://github.com/MaLaNg116/itervane/actions/runs/45018166747/artifacts/14752842985)
