# 正式上线回执时间顺序导读

真库回归发现上线核验结束后，数据库时钟读数比领取时低约 0.8 秒，引发 `formal_rollout_outcome` 约束拒绝。代码与测试固定在 `00b4564926d720a45b85b601f5f9da4d71217357`。 [PR #91](https://github.com/MaLaNg116/itervane/pull/91) · [修复计划](../plans/rollout-timestamp-order.md)

1. 迁移 0049 更新结算函数，将领取时间作为回执完成时间的下界。结算继续以数据库当前时间核对执行权，回执时间仍受原租约截止时间约束。健康、原生更新与环境映射全由现有检查验证。 [结算时间](https://github.com/MaLaNg116/itervane/blob/00b4564926d720a45b85b601f5f9da4d71217357/packages/control-plane/migrations/0049_rollout_timestamp_order.sql#L98)
2. PostgreSQL 对照用例在隔离库中使领取时间领先于数据库时钟。修复前复现约束失败，修复后正式发布按原证据成功结算，回执时间等于领取时间。用例清理临时测试触发器。 [时钟回退用例](https://github.com/MaLaNg116/itervane/blob/00b4564926d720a45b85b601f5f9da4d71217357/packages/control-plane/test/integration/inspections.test.ts#L3911)

TypeScript、229 项单元、Drizzle 迁移一致性和四项 PostgreSQL 17.12 专项通过。四项覆盖时钟回退、正常上线、过期执行者与不完整证据、排队处置到期后的发布。 [托管检查](https://github.com/MaLaNg116/itervane/pull/91/checks)

#83 的本机复验还遇到了领取阶段的 `formal_rollout_lease_required`。在 `ad13cd2cc9fd9311b230908b36e8ff95f08e7c24`，新 Worker 用语句时间计算请求期限，迁移 0050 用同一时钟来源记录起点，并以实时数据库时钟检查租约尚在有效期内。基于绝对期限的旧 Worker 仍可领取。PostgreSQL 17.12 五项通过，包括修复前失败的精确 45 秒间隔、旧写入兼容、越界拒绝和上线回执对照。 [领取](https://github.com/MaLaNg116/itervane/blob/ad13cd2cc9fd9311b230908b36e8ff95f08e7c24/packages/control-plane/src/runtime/formal-rollout-claim.ts#L129) · [迁移 0050](https://github.com/MaLaNg116/itervane/blob/ad13cd2cc9fd9311b230908b36e8ff95f08e7c24/packages/control-plane/migrations/0050_rollout_claim_timestamp.sql#L62)

#91 合入前复核版本为 `2fc3176c11513526d8436048cbd748046d355043`。三项常规检查和九组托管 KVM 通过。受保护应用报告指纹为 `9211c4a5b97a3fdaadc42e8c6ff94b4657a0ae7f7fe5f988a5e3a0e1762c4481`，记录匿名 401、授权健康 200、同一目标、四类诊断事实和槽位释放。合入提交为 `e2ccbe092851cb311cd2e2447a2f4d1e0f6ec6d5`。 [托管复核](https://github.com/MaLaNg116/itervane/actions/runs/45012519473) · [合入](https://github.com/MaLaNg116/itervane/pull/91)
