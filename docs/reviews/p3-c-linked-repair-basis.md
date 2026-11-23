# P3-C3-C1 · 关联修复提案

接续 #124 的健康触发诊断。提案契约和迁移为 `0bbf85391b0e9cd131701bc705cac2632e202ae3`，领域实现为 `f05b822a2c5f85eb9e2dbf49c72fb2c0eded074a`，真库用例为 `2a91662dc3c56f909970cd21e3784fb4dc439135`。 [阶段计划](../plans/p3-c-operations-incidents.md) · [PR #125](https://github.com/MaLaNg116/itervane/pull/125)

1. 从诊断任务读取可核验的正式回执。只有具备日志与发布证据的 `investigate_code` 建议能进入提案。当前项目授权、登记、发布或恢复、目标和容器都要再次核对。监控诊断带上原事件 ID 和触发样本序号，手动诊断保留自身渠道。 [提案基准](https://github.com/MaLaNg116/itervane/blob/f05b822a2c5f85eb9e2dbf49c72fb2c0eded074a/packages/control-plane/src/service/operations-repair-proposals.ts#L58)
2. 读取发布候选和同一版本的合格复验账本，核对登记 Git 来源、固定版本、原始快照、实际发布快照和补丁摘要。提案有效期沿用诊断时间及登记策略。后续关联任务可以据此核对它将要读取的源码。 [源码基准](https://github.com/MaLaNg116/itervane/blob/f05b822a2c5f85eb9e2dbf49c72fb2c0eded074a/packages/control-plane/src/service/operations-repair-proposals.ts#L30)
3. 锁定原诊断任务，按诊断运行唯一写入提案并保存摘要。重复调用返还同一提案，同时重新核对提案者授权。数据库约束复查当前发布与原事件关联，已保存提案具备不可变保护。 [并发和重放](https://github.com/MaLaNg116/itervane/blob/f05b822a2c5f85eb9e2dbf49c72fb2c0eded074a/packages/control-plane/src/service/operations-repair-proposals.ts#L84) · [迁移](https://github.com/MaLaNg116/itervane/blob/0bbf85391b0e9cd131701bc705cac2632e202ae3/packages/control-plane/migrations/0064_operations_repair_proposals.sql)

本地 TypeScript、253 项单元、13 项 PostgreSQL 17.12 专项和 Drizzle 迁移一致性检查通过。四个新增用例运行正式运维 Agent 的证据循环，使用确定性模型与 Whiskers 响应夹具，覆盖并发去重、事件关联、项目权限和撤权、错误建议或摘要、来源替换与确认期。其余九项是健康事件及准入回归。用于验证修复后的源码基准、正式任务接收和原生发布的用例随 C3-C2、C3-C3 接续。 [真库用例](https://github.com/MaLaNg116/itervane/blob/2a91662dc3c56f909970cd21e3784fb4dc439135/packages/control-plane/test/integration/inspections.test.ts#L3121) · [托管检查](https://github.com/MaLaNg116/itervane/pull/125/checks)
