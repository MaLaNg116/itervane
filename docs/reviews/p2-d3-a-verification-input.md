# P2-D3-A · 正式复验输入导读

本批依赖 [P2-D2 #23](https://github.com/MaLaNg116/itervane/pull/23)，固定实现版本为 `45003f1`。它准备独立复验使用的不可变证据。批次顺序见 [P2-D3 实施计划](../plans/p2-d3-formal-verification.md)。

## 代码顺序

1. 复验输入沿用正式审计的任务、执行代次、固定源码、扫描和规则证据。复验 profile 额外固定平台策略、基线、扫描器输入和 Runner 镜像摘要。候选来源区分原始快照和正式修复，记录只保存引用与指纹。 [契约](https://github.com/MaLaNg116/itervane/blob/45003f1281a6d1d8781568ccea1ebc5086a945c6/packages/contracts/src/formal-verification.ts#L6)
2. Worker 的准备函数在持有当前项目授权和租约时读取已核验的正式审计。原始分支检查完整扫描回执没有发现。修复分支验证当前 run 的已发布候选及其检查点，复用导出流程的精确回执与规范补丁核验，再核对固定 Git 来源和扫描清单。 [复验准备](https://github.com/MaLaNg116/itervane/blob/45003f1281a6d1d8781568ccea1ebc5086a945c6/packages/control-plane/src/runtime/verification-input.ts#L14) · [共用的回执核验](https://github.com/MaLaNg116/itervane/blob/45003f1281a6d1d8781568ccea1ebc5086a945c6/packages/control-plane/src/service/repair-result.ts#L68)
3. PostgreSQL 在写入时复核执行代次、租约、已保存扫描和具体候选。结果保留为不可变记录，同一输入在续领时返回原摘要。变更 profile 后原输入产生冲突，由新 run 重新准备。迁移快照由 Drizzle 生成，约束和触发器的验收使用真实数据库。 [迁移和写入约束](https://github.com/MaLaNg116/itervane/blob/45003f1281a6d1d8781568ccea1ebc5086a945c6/packages/control-plane/migrations/0019_formal_verification_inputs.sql#L15)

## 可复跑验收

- Linux `pnpm check` 通过严格类型检查和 146 项单元测试。
- 真实 PostgreSQL 的复验相关专项验证无发现原稿、从正式队列生成的修复候选、重复与新租约、旧租约和撤权、替换候选指纹、修改策略，以及有发现但还未发布候选。现有 HTTP/MCP 读面、授权补丁导出及旧审计接续用例一并复核。 [修复候选和现有读面](https://github.com/MaLaNg116/itervane/blob/45003f1281a6d1d8781568ccea1ebc5086a945c6/packages/control-plane/test/integration/inspections.test.ts#L501) · [无发现和未修复样例](https://github.com/MaLaNg116/itervane/blob/45003f1281a6d1d8781568ccea1ebc5086a945c6/packages/control-plane/test/integration/inspections.test.ts#L576)
- 全量 116 项 PostgreSQL 集成测试通过。`pnpm exec tsx scripts/test-postgres.ts` 可复跑，默认创建本次测试独占的临时 PostgreSQL。

本批验收证据准备和保存。D3-B 在一次性 VM 内重放并重新扫描，D3-C 完成针对性测试、受保护构建和镜像扫描，D3-D 接入正式 Worker、复验 Agent 与中英文读面。真实发布继续走 P2-E 的人工审批和下游核对。
