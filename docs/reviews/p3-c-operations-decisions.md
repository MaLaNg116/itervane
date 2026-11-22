# P3-C1b1 · 运维人工决策 Review Guide

[草稿 #84](https://github.com/MaLaNg116/itervane/pull/84) 接续 [处置提案 #83](https://github.com/MaLaNg116/itervane/pull/83)。实现和测试固定在 `ec7b67d2f9198ac2d657c94770168e6e14a7b166`。 [实施计划](../plans/p3-c-operations-decisions.md)

1. 看 `isHumanWorkspaceOwner`。发布审批和处置审批都要求当前工作区所有者及配置的门户客户端。决策行保留主体、授权代次和本人确认。 [身份边界](https://github.com/MaLaNg116/itervane/blob/ec7b67d2f9198ac2d657c94770168e6e14a7b166/packages/control-plane/src/service/access.ts)
2. 看 `OperationsDecisionService.decide`。在同一事务重核提案指纹和决策版本。首次决定重新核对提案提交者授权、诊断、发布、登记与有效期，重复请求重放历史。确认可以接续撤销，审批记录与原诊断回执并存。 [决策服务](https://github.com/MaLaNg116/itervane/blob/ec7b67d2f9198ac2d657c94770168e6e14a7b166/packages/control-plane/src/service/operations-decisions.ts#L16)
3. 看数据库触发器和测试。决策按版本顺序写入，历史不可更改。实际 PostgreSQL 覆盖本人确认、并发、撤销、过期、换绑、撤权和待发布冲突。 [迁移](https://github.com/MaLaNg116/itervane/blob/ec7b67d2f9198ac2d657c94770168e6e14a7b166/packages/control-plane/migrations/0045_operations_decisions.sql) · [真库测试](https://github.com/MaLaNg116/itervane/blob/ec7b67d2f9198ac2d657c94770168e6e14a7b166/packages/control-plane/test/integration/inspections.test.ts#L2810)

本机 TypeScript、224 项单元、九项运维真库专项、八项发布决策回归及迁移一致性检查通过。C1b2 接续双语入口与查询，C2 接续运行资格、下游确认和恢复验证。 [托管检查](https://github.com/MaLaNg116/itervane/actions/runs/44982088637) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/44982088627)
