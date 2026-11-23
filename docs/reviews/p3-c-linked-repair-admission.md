# P3-C3-C2 · 关联修复确认与固定源码

接续 #125。固定确认实现 `2b8d6903ade1588d40692271c976aa25e57540e6`，Runner 与发布闸门 `5814fb8f473f7dda76a3a74d64aac4739333450a`，完整用例 `c57d832191615d60c9e80fe27486bd5ff5529cc4`。 [实施计划](../plans/p3-c-linked-repair-admission.md) · [PR #126](https://github.com/MaLaNg116/itervane/pull/126)

1. 门户所有者确认提案指纹和固定源码。权限、来源、应用、登记和有效期都重读。一次事务保存确认记录、普通 `audit` 任务、事件和首次 pg-boss 唤醒。确认人和授权代次入库，重复确认返还同一任务。领取和接管使用原有执行槽。 [确认与入队](https://github.com/MaLaNg116/itervane/blob/2b8d6903ade1588d40692271c976aa25e57540e6/packages/control-plane/src/service/operations-repair-admission.ts#L15)
2. 原始发布需匹配已核验的 Git 快照。已经发布补丁时，确认者提供固化该补丁的同仓库提交。一次性 VM 根据完整文件清单重算原候选摘要，回执绑定新提交、原基准、权限和清理证据。正式审计重查回执。仓库来源或实际内容有差异时，通过双语事件暂停任务。 [来源匹配](https://github.com/MaLaNg116/itervane/blob/5814fb8f473f7dda76a3a74d64aac4739333450a/packages/control-plane/src/service/operations-repair-proposals.ts#L45) · [Runner 回执](https://github.com/MaLaNg116/itervane/blob/5814fb8f473f7dda76a3a74d64aac4739333450a/packages/control-plane/src/runtime/source-inspection.ts#L125)
3. 冻结发布候选及人工批准时重查原发布和环境登记。后续写入仍沿用正式发布 Worker 对授权、候选与目标的核验。 [发布闸门](https://github.com/MaLaNg116/itervane/blob/5814fb8f473f7dda76a3a74d64aac4739333450a/packages/control-plane/src/service/operations-repair-proposals.ts#L54)

本地 TypeScript、253 项单元、71 项 Linux Runner 宿主测试、13 项 PostgreSQL 17.12 专项和迁移一致性检查通过。真库用例使用签名 OIDC、确定性模型、Whiskers 和 Runner 回执夹具，覆盖并发确认、单次事务回滚、过期、撤权与重授、租约接管、来源漂移、实测摘要不匹配和发布目标更换。 [真库用例](https://github.com/MaLaNg116/itervane/blob/c57d832191615d60c9e80fe27486bd5ff5529cc4/packages/control-plane/test/integration/inspections.test.ts#L3216)

托管 KVM 使用旧补丁的实际回执与两份固定 Git 提交对照。已发布和固化后的内容摘要同为 `4ec66954…b3e06b`，不同内容为 `eba9279b…50cc9`，三台独立 VM 均确认清理。#126 的固定版本通过 17 项托管检查后合入 `b00ee6a`。完整应用故障、代码修改及新版本运行核对由 C3-C3 接续。 [原生探针](https://github.com/MaLaNg116/itervane/blob/c57d832191615d60c9e80fe27486bd5ff5529cc4/scripts/probe-qualified-runner.ts#L70) · [固化提交](https://github.com/MaLaNg116/itervane/commit/fbfef7c887323132fac193a4c0b538cc97f60995) · [内容变化对照](https://github.com/MaLaNg116/itervane/commit/93ce12b8bcba237ffd98412a188584b225bb0854) · [回归任务](https://github.com/MaLaNg116/itervane/actions/runs/45115270871/job/137496560016)
