# P4-D2b2 · 正式任务固定规则检查与证据留存

本批基于原生 Runner 的规则扫描回执。先看工作计划与前置导读。 [本批计划](../plans/p4-formal-published-inspection.md) · [#148](https://github.com/MaLaNg116/itervane/pull/148) · [原生规则扫描证据](p4-qualified-published-inspection.md)

1. `8ce7d69` 从任务快照查找对应的激活序号、包版本、人工审核与已通过的候选验证。正常项目隔离和工作区范围在读规则时再核对，历史读回保持提交时选取的版本。 [任务规则读取](https://github.com/MaLaNg116/itervane/blob/8ce7d69/packages/control-plane/src/service/task-published-code-rules.ts)
2. `aeecf65` 现有租约下保留命令、引擎、快照摘要和回执绑定。迁移 0078 在数据库中核对创建时的规则快照及回执一致性，禁止改动已记录的检查请求依据。历史读回重新组装规则和命令。缺少规则执行资格或覆盖时任务暂停，冻结规则的任务在独立规则复验接入前等待发布资格。 [检查执行](https://github.com/MaLaNg116/itervane/blob/aeecf65/packages/control-plane/src/runtime/source-inspection.ts) · [回执核对](https://github.com/MaLaNg116/itervane/blob/aeecf65/packages/control-plane/src/service/inspection-evidence.ts) · [迁移](https://github.com/MaLaNg116/itervane/blob/aeecf65/packages/control-plane/migrations/0078_published_inspection_basis.sql)
3. `2af4b6e` 通过现有项目授权和双语详情页显示规则检查进度、扫描文件数和命中数。 [双语摘要](https://github.com/MaLaNg116/itervane/blob/2af4b6e/packages/portal/src/pages/task.tsx)
4. `361c27d` 通过 PostgreSQL 在已发布规则上执行正式选取与回执留存，验证执行画像缺失时未派发、使用新镜像的相同扫描工具、撤回后重读原回执以及后续任务选取空集合。 [旧任务与规则检查真库回归](https://github.com/MaLaNg116/itervane/blob/361c27d/packages/control-plane/test/integration/inspections.test.ts)
5. `e0fbe56` 无命中任务的历史回归复用已有队列等待助手。先等 Worker 领取实际工作，再断言任务进入审计完成后的状态，降低队列暂时为空导致的误判。 [队列回归](https://github.com/MaLaNg116/itervane/blob/e0fbe56/packages/control-plane/test/integration/inspections.test.ts)

TypeScript、Drizzle 检查和 282 项单测通过。PostgreSQL 17.12 上运行 5 项专项，覆盖上述业务路径、无规则任务、旧执行者和读取权限，使用受控模型与 Runner 回执夹具。真实 Semgrep 与 KVM 回执来自 #148 的固定样例扫描。接下来验收正式审计读取、独立复验及第二个登记项目从真实发布规则得到结果。
