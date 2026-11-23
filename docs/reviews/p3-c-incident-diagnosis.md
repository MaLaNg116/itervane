# P3-C3-B1 · 从健康异常到诊断任务

基于已合入 #122 的 `main`。监控登记与迁移为 `55d776980b24931924e1e2514f875defb992d43f`，准入实现为 `66db643eb8e2ef1c0029715ab19d17b713fb47f1`，真库用例为 `0026ad55a8ee2da4e63a152ef4835fe54a17fb7c`。 [阶段计划](../plans/p3-c-operations-incidents.md) · [PR #123](https://github.com/MaLaNg116/itervane/pull/123)

1. 本机登记命令给受保护环境建立内部诊断主体与项目授权代次，固定发布登记、运维登记、诊断模型指纹、语言和有效期。替换和撤销都需要当前登记 ID。核对 `urn:itervane:incident-monitor` 主体与平台的 OIDC 登录边界。 [登记与撤销](https://github.com/MaLaNg116/itervane/blob/55d776980b24931924e1e2514f875defb992d43f/packages/control-plane/src/service/operations-incident-monitor.ts#L24) · [迁移](https://github.com/MaLaNg116/itervane/blob/55d776980b24931924e1e2514f875defb992d43f/packages/control-plane/migrations/0063_operations_incident_diagnoses.sql)
2. 环境行锁定界当前发布和健康证据。只有最新可信异常能入队，用一个事务保存诊断任务、冻结输入、样本关联和 pg-boss 唤醒。重复轮询复用活动任务。重试读取更新的异常证据，按环境执行冷却和事件次数限制，记录转人工的原因。 [准入与预算](https://github.com/MaLaNg116/itervane/blob/66db643eb8e2ef1c0029715ab19d17b713fb47f1/packages/control-plane/src/service/operations-incident-scheduler.ts#L19)
3. 正式 Worker 领取和继续使用现有执行权。每次使用租约时重新核对项目授权、监控登记、事件和当前实例。冲突处置期间延后领取，实例已经替换或登记已经失效时进入待人工状态。 [执行权复核](https://github.com/MaLaNg116/itervane/blob/66db643eb8e2ef1c0029715ab19d17b713fb47f1/packages/control-plane/src/runtime/coordinator.ts#L21)

本机 TypeScript、253 项单元、九项 PostgreSQL 17.12 专项和迁移一致性检查通过。新增六项覆盖重复轮询和租约接管、实库失败原子回滚、两分钟冷却与三次预算、项目授权代次和监控撤销、登记过期、待发布环境和实例替换。三项健康事件账本回归一并通过。授权测试通过角色往返触发数据库刷新授权代次。预算场景用固定任务结算驱动调度，B2 接入实际诊断 Worker、Whiskers 和受保护应用。 [专项断言](https://github.com/MaLaNg116/itervane/blob/0026ad55a8ee2da4e63a152ef4835fe54a17fb7c/packages/control-plane/test/integration/inspections.test.ts#L2173) · [托管检查](https://github.com/MaLaNg116/itervane/pull/123/checks)
