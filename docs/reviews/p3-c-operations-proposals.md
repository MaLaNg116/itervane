# P3-C1a · 运维处置提案 Review Guide

[草稿 #83](https://github.com/MaLaNg116/itervane/pull/83) 接续 [正式诊断 #82](https://github.com/MaLaNg116/itervane/pull/82)。交付代码固定在 `8710b024e233a2888ddf3a4e7dc11e855f0d054c`。 [分批计划](../plans/p3-c-operations-proposals.md)

1. 看 `readOperationsTaskRecord`。诊断详情和提案服务共用任务、观察、检查点、结算和证据核对。提案使用领域记录，门户通过已授权的查询得到语言投影。 [证据读取](https://github.com/MaLaNg116/itervane/blob/8710b024e233a2888ddf3a4e7dc11e855f0d054c/packages/control-plane/src/service/operations-records.ts)
2. 看 `OperationsProposalService.freeze`。调用方提供诊断摘要，领域服务复核项目写权限、原提交授权、当前发布和登记，再根据结论确定动作。恢复提案绑定诊断引用的既有镜像及核验记录。数据库结算时间和发布配置决定有效期。 [提案服务](https://github.com/MaLaNg116/itervane/blob/8710b024e233a2888ddf3a4e7dc11e855f0d054c/packages/control-plane/src/service/operations-proposals.ts#L31)
3. 看 `0044`。PostgreSQL 约束每个诊断 run 的唯一提案与不可变记录。触发器核对目标、授权、有效期和已核验的发布状态。重复提交在诊断任务行锁下重放同一提案。 [迁移](https://github.com/MaLaNg116/itervane/blob/8710b024e233a2888ddf3a4e7dc11e855f0d054c/packages/control-plane/migrations/0044_operations_proposals.sql#L24)
4. 看真库验收。使用已走正式领域结算的合成目标覆盖重启、两个不同版本、并发去重、指纹或动作参数变化、超期、撤权、换绑和待发布冲突。 [集成用例](https://github.com/MaLaNg116/itervane/blob/8710b024e233a2888ddf3a4e7dc11e855f0d054c/packages/control-plane/test/integration/inspections.test.ts#L2731)

本机 TypeScript、224 项单元、十项 PostgreSQL 17.12 专项及迁移一致性检查通过。审批记录和双语入口由 C1b 接续，执行与恢复验证由 C2 接续。 [托管检查](https://github.com/MaLaNg116/itervane/actions/runs/44981434652) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/44981434576)
