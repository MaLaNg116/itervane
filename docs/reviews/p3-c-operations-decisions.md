# P3-C1b1 · 运维人工决策 Review Guide

本批接续处置提案，实现和测试固定在 `ec7b67d2f9198ac2d657c94770168e6e14a7b166`。 [PR #84](https://github.com/MaLaNg116/itervane/pull/84) · [处置提案 #83](https://github.com/MaLaNg116/itervane/pull/83) · [实施计划](../plans/p3-c-operations-decisions.md)

1. 看 `isHumanWorkspaceOwner`。发布审批和处置审批都要求当前工作区所有者及配置的门户客户端。决策行保留主体、授权代次和本人确认。 [身份边界](https://github.com/MaLaNg116/itervane/blob/ec7b67d2f9198ac2d657c94770168e6e14a7b166/packages/control-plane/src/service/access.ts)
2. 看 `OperationsDecisionService.decide`。在同一事务重核提案指纹和决策版本。首次决定重新核对提案提交者授权、诊断、发布、登记与有效期，重复请求重放历史。确认可以接续撤销，审批记录与原诊断回执并存。 [决策服务](https://github.com/MaLaNg116/itervane/blob/ec7b67d2f9198ac2d657c94770168e6e14a7b166/packages/control-plane/src/service/operations-decisions.ts#L16)
3. 看数据库触发器和测试。决策按版本顺序写入，历史不可更改。实际 PostgreSQL 覆盖本人确认、并发、撤销、过期、换绑、撤权和待发布冲突。 [迁移](https://github.com/MaLaNg116/itervane/blob/ec7b67d2f9198ac2d657c94770168e6e14a7b166/packages/control-plane/migrations/0045_operations_decisions.sql) · [真库测试](https://github.com/MaLaNg116/itervane/blob/ec7b67d2f9198ac2d657c94770168e6e14a7b166/packages/control-plane/test/integration/inspections.test.ts#L2810)

本机 TypeScript、224 项单元、九项运维真库专项、八项发布决策回归及迁移一致性检查通过。C1b2 接续双语入口与查询，C2 接续运行资格、下游确认和恢复验证。 [托管检查](https://github.com/MaLaNg116/itervane/actions/runs/44982088637) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/44982088627)

## 合入复验

以合入 #83 后的 `eaa05dfee45ba003624d3b28c6296c3f46a86384` 复审当前门户身份和授权代次、不可变决定历史及提案失效逻辑。PostgreSQL 17.12 的六项本机复验通过，覆盖人工确认与撤销、重复决定、并发、过期、撤权、换绑和待发布冲突。托管推送及 PR 的 deterministic、portal、scanners 均成功。 [PR 检查](https://github.com/MaLaNg116/itervane/actions/runs/44994305320) · [推送检查](https://github.com/MaLaNg116/itervane/actions/runs/44994300326)

同版原生 Whiskers 与安装态 KVM 运维诊断通过。产物显示诊断关联当前发布目标，保存容器、发布历史、日志和指标，HTTP 与 MCP 查询一致，临时 Whiskers 安装已清理。源码指纹为 `cbdd2f95199221c9a5152adfd8d81be5a6e4b499d00586b7e0a448a934e666df`。 [原生 Whiskers](https://github.com/MaLaNg116/itervane/actions/runs/44994300304) · [安装态诊断](https://github.com/MaLaNg116/itervane/actions/runs/44994300285/job/137121900446)
