# P3-C2d1 · 指定版本的恢复依据导读

依赖 #106。固定代码与测试为 `fa6d2b3171081693b5389a25dbaee52c443fea94`。 [阶段计划](../plans/p3-c-operations-restore.md) · [PR #107](https://github.com/MaLaNg116/itervane/pull/107)

1. 先在当前受保护环境中读取最新正式发布，再核对其候选、原生派发回执、实际镜像和受保护健康结果。发布未结算时返回冲突，最新发布的目标登记过期或证据异常时终止本次读取。 [当前版本读取](https://github.com/MaLaNg116/itervane/blob/fa6d2b3171081693b5389a25dbaee52c443fea94/packages/control-plane/src/service/operations-deployment.ts#L60)
2. 需要恢复依据时，按同一目标登记的版本和摘要筛选已核验历史，选择镜像摘要与当前不同的最近发布。对选中的记录执行同样的回执核对。诊断事实、提案及人工确认继续绑定具体发布操作和回执指纹。 [历史版本选择](https://github.com/MaLaNg116/itervane/blob/fa6d2b3171081693b5389a25dbaee52c443fea94/packages/control-plane/src/service/operations-deployment.ts#L96)
3. 真库场景模拟 A → B → B，核对提案以最后一次发布的 B 为当前版本，用 A 的发布 ID、镜像摘要和回执指纹冻结恢复对象。人审后内部处置队列绑定该提案。另一组核对待结算发布、项目角色和目标登记变化。 [授权及登记变更](https://github.com/MaLaNg116/itervane/blob/fa6d2b3171081693b5389a25dbaee52c443fea94/packages/control-plane/test/integration/inspections.test.ts#L2138) · [重复发布与提案](https://github.com/MaLaNg116/itervane/blob/fa6d2b3171081693b5389a25dbaee52c443fea94/packages/control-plane/test/integration/inspections.test.ts#L2801)

本机 TypeScript、246 项单元和七项 PostgreSQL 17.12 专项通过。本批交付正式诊断和提案的恢复依据，Komodo 派发、恢复结算及原生联验分别在 C2d2–C2d4 验收。 [托管检查](https://github.com/MaLaNg116/itervane/pull/107/checks)
