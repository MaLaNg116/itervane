# P4-D5 · 正式审计使用已发布的设计 Skill

正式审计按任务接收时保存的规则快照读取已审核的设计 Skill。规则版本、审核摘要、激活序号和读取回执随报告保留。 [实施计划](../plans/p4-audit-design-guidance.md) · [#158](https://github.com/MaLaNg116/itervane/pull/158)

1. `31bebe5` 复用历史发布版本解析，校验作用域和审核。输入封存时保留同语言摘要和 `SKILL.md` 摘录，各最多 160 个 UTF-16 代码单元。附件仍归规则库管理。已有审计输入可以按原内容恢复。 [固定版本](https://github.com/MaLaNg116/itervane/blob/31bebe5/packages/control-plane/src/service/audit-design-guidance.ts) · [正式输入](https://github.com/MaLaNg116/itervane/blob/31bebe5/packages/control-plane/src/service/formal-audit.ts)
2. 同一次提交把资料接入审计 Agent 已有的只读 `read_rule`。引入的内容作为供人工核对的资料。Agent 的工具目录、扫描证据及完成条件由原有平台路径计算。数据库迁移 `0084` 约束固定引用和审计证据的一致性。 [Agent 工具](https://github.com/MaLaNg116/itervane/blob/31bebe5/packages/agent/src/formal-audit.ts) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/31bebe5/packages/control-plane/migrations/0084_design_skill_audit_evidence.sql)
3. `817e057` 用真实 PostgreSQL 验证已审核版本、草稿及其他项目排除、后续版本发布、回滚和历史仍可读取。测试在得到带误导指令的指导后核对两项扫描仍为必要条件，并直接验证数据库拒绝删除指导字段或提交遗漏版本来源的证据。 [真库用例](https://github.com/MaLaNg116/itervane/blob/817e057/packages/control-plane/test/integration/inspections.test.ts)
4. `b1640ea` 在双语审计证据中显示包键和版本。证据 DTO 只包含引用元数据，原始资料仍按规则读取权限获取。 [门户](https://github.com/MaLaNg116/itervane/blob/b1640ea/packages/portal/src/pages/task-audit.tsx) · [浏览器用例](https://github.com/MaLaNg116/itervane/blob/b1640ea/packages/portal/test/browser/portal.spec.ts)

TypeScript、287 项单测、Drizzle 检查、PostgreSQL 17.12 上的 6 项专项和 1 项双语 Chrome 用例通过。这里的 Agent 专项使用受控 Anthropic 模型和已授权的 Runner 回执夹具。Chrome 通过实际 Keycloak 登录，以固定审计报告覆盖渲染。托管 KVM 回归跟随本批 PR。 [前批真实代码规则复用](p4-native-rule-reuse.md) · [前批真实运维复用](p4-native-runbook-reuse.md)
