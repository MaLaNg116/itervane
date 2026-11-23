# P3-C2d3a · 指定版本的独立核验导读

依赖 #110，固定代码与测试为 `6b655b87804bccffad4f84c9ef92fc274e8bf7e2`。 [实施计划](../plans/p3-c-operations-restore.md) · [PR #111](https://github.com/MaLaNg116/itervane/pull/111)

1. 核验 Worker 只读已保存的原生更新 ID。每次访问前复核当前核验租约、原计划和登记目标。Komodo 更新完成并成功后，入口核验器检查实际镜像、恢复版本、新容器、匿名拒绝与授权健康。 [独立核验入口](https://github.com/MaLaNg116/itervane/blob/6b655b87804bccffad4f84c9ef92fc274e8bf7e2/packages/control-plane/src/runtime/operations-restore-recovery-worker.ts#L23)
2. 迁移 0059 保存有代次的核验记录。正向回执绑定派发更新、已批准制品和实际运行证明。未知更新、已知失败和目标变化进入人工核对。更新未完成、服务暂不可用或租约过期最多核对三次。回执、双语事件、调度与租约关闭在同一事务提交。 [记录与提交期约束](https://github.com/MaLaNg116/itervane/blob/6b655b87804bccffad4f84c9ef92fc274e8bf7e2/packages/control-plane/migrations/0059_operations_restore_recoveries.sql#L31)
3. PostgreSQL 首轮发现时钟回拨使生成的提案时间早于已保存的诊断。迁移 0060 将提案、人工批准、处置预约和撤销的时间与各自前序记录绑定，并保留批准有效期与授权检查。真库模拟数据库时钟落后于已记录的诊断时间，核对预约和撤销的时间顺序。 [时间约束](https://github.com/MaLaNg116/itervane/blob/6b655b87804bccffad4f84c9ef92fc274e8bf7e2/packages/control-plane/migrations/0060_operations_authority_clock.sql) · [专用回归](https://github.com/MaLaNg116/itervane/blob/6b655b87804bccffad4f84c9ef92fc274e8bf7e2/packages/control-plane/test/integration/inspections.test.ts#L3087)

类型检查、247 项单元和 12 项 PostgreSQL 17.12 专项通过。真库使用可控 Komodo 与入口观测，覆盖未知回执、错误容器、限次、接管、授权顺序及双语事件。已核验事实等待 C2d3b 的原子结算与实际运行版本登记，完整原生双版本联验在 C2d4。 [托管检查](https://github.com/MaLaNg116/itervane/pull/111/checks)

固定代码的九项托管 KVM 全部通过，覆盖现有隔离、构建、发布、入口和重启回归。 [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45025534882)
