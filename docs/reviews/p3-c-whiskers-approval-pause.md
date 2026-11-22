# P3-C2c1 · Whiskers 申请绑定与审批暂停导读

接续 #90 的处置执行权与 #91 的时钟修复，代码与测试固定在 `8894a476e822ff102f65e26b4775b2ff9deb6f04`。 [PR #92](https://github.com/MaLaNg116/itervane/pull/92) · [C2c 阶段计划](../plans/p3-c-whiskers-restart-execution.md)

1. `3e228df` 下的迁移 0051 将原生调用记录绑定到受保护环境的处置发送意图。固定 Whiskers 来源、服务器参数、全长容器 ID、工具名和调用凭证指纹。初始记录以已登记目标和当前 fence 为准，回执绑定同一申请。 [请求及回执约束](https://github.com/MaLaNg116/itervane/blob/8894a476e822ff102f65e26b4775b2ff9deb6f04/packages/control-plane/migrations/0051_operations_restart_requests.sql#L17)
2. `7a5a908` 用同一事务记录原生批准 ID、切换任务与运行状态、追加双语事件并释放全局执行槽。同环境的冲突发布继续受处置占用阻断。延迟约束核对回执、事件、队列和槽状态。 [暂停逻辑](https://github.com/MaLaNg116/itervane/blob/8894a476e822ff102f65e26b4775b2ff9deb6f04/packages/control-plane/src/runtime/operations-execution-lease.ts#L161) · [提交期约束](https://github.com/MaLaNg116/itervane/blob/8894a476e822ff102f65e26b4775b2ff9deb6f04/packages/control-plane/migrations/0051_operations_restart_requests.sql#L88)
3. 原生回执若在撤销后才到达，登记后直接安排只读核对。已暂停的任务也在平台撤销事务中切换到核对状态，保留已有回执和同环境占用。 [撤销衔接](https://github.com/MaLaNg116/itervane/blob/8894a476e822ff102f65e26b4775b2ff9deb6f04/packages/control-plane/src/runtime/operations-restart-request.ts#L32)
4. `8894a47` 用真实 PostgreSQL 核对目标绑定、过期执行者、事件故障回滚和撤销前后到达的回执。其他开发任务可在原生等待期间使用全局槽。 [真库用例](https://github.com/MaLaNg116/itervane/blob/8894a476e822ff102f65e26b4775b2ff9deb6f04/packages/control-plane/test/integration/inspections.test.ts#L2891)

本机 TypeScript、229 项单元、七项 PostgreSQL 17.12 专项与 Drizzle 迁移一致性通过。六项在同组运行通过。一项在旧处置准入的准备阶段被数据库拒绝，隔离复跑通过并核对伪造目标被当前约束拒绝。C2c2 接入符合原生 Confirm 策略的实际派发和受控续发，C2c3 接续运行状态与受保护入口的独立核验。 [托管检查](https://github.com/MaLaNg116/itervane/pull/92/checks)

2026-11-22 合入复核固定在 `a17c8d349e32805f1526661045a2ea90abcfb815`。核对了原生申请绑定、暂停事务、撤销后的核对队列与环境占用。17 项托管检查全部通过，含九组 KVM、原生 Whiskers、密封输入及常规回归。 [KVM 联验](https://github.com/MaLaNg116/itervane/actions/runs/45015438117) · [原生确认](https://github.com/MaLaNg116/itervane/actions/runs/45015438102) · [主线合并提交](https://github.com/MaLaNg116/itervane/commit/43885d739a0afb7ee40ccea58bfd098134d8790b)
