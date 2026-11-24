# P4-A2 · 设计 Skill 审核与版本发布

接续 [PR #135](https://github.com/MaLaNg116/itervane/pull/135)。审核实现为 `539959fe32fa64b4e32d72237df136a916c264fd`，版本切换为 `4e8a562072406753ea047f41a22cfcf3674c5fab`，数据库约束为 `1acee60f1e7904833f81088ec9bf11f636155a02`。 [实施计划](../plans/p4-design-skill-publication.md)

1. 门户所有者按版本正文的 SHA-256 审阅来源与许可证、范围和指导、设计资料。提交回执包含审核人和授权代次，同内容可重放。换授权后可以重审同一版本，原回执仍可追查。摘要与详情显示当前授权下的审核状态。 [审核事务](https://github.com/MaLaNg116/itervane/blob/539959fe32fa64b4e32d72237df136a916c264fd/packages/control-plane/src/service/rule-packages.ts#L135)
2. 发布、回滚、撤销使用同一包锁和递增序号。发布及回滚绑定通过的审核摘要，回滚另核对过去的发布记录。重复请求回放第一次记录并附带当前状态，历史回执保持首次目标与版本。 [切换事务](https://github.com/MaLaNg116/itervane/blob/4e8a562072406753ea047f41a22cfcf3674c5fab/packages/control-plane/src/service/rule-package-activations.ts#L45) · [数据库闸门](https://github.com/MaLaNg116/itervane/blob/1acee60f1e7904833f81088ec9bf11f636155a02/packages/control-plane/migrations/0072_rule_package_publication.sql#L80)
3. HTTP 查询提供当前激活版本和最近历史，审核结果与激活状态各自独立。设计资源和审核意见是文本数据。本批完成设计材料的人工审核，正式任务的版本固定、模型检索和代码规则的 VM 验证分别在 P4 后续子批接入。 [P4 总计划](../plans/p4-rule-learning.md)

本地 TypeScript、Drizzle、253 项单元和 PostgreSQL 17.12 的 14 项专项通过。覆盖角色、审核意见、授权代次变化、并发审核与发布、有效历史回滚、撤销和直接改写拒绝。用例使用签名 OIDC 测试身份和合成设计材料。 [真库用例](https://github.com/MaLaNg116/itervane/blob/08d273b51d3a051e76ec58e1206023c9fd403fa5/packages/control-plane/test/integration/rule-packages.test.ts#L236) · [托管检查](https://github.com/MaLaNg116/itervane/pull/136/checks)
