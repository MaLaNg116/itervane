# P2-E-C3-B · 正式发布认领与执行权恢复

基于已合入的 Registry 来源与目标绑定。 [PR #46](https://github.com/MaLaNg116/itervane/pull/46) · [实施计划](../plans/p2-e-formal-release-claim.md)

1. `3122006` 为正式操作持久化当前唤醒 ID。首次入队使用操作 ID 并兼容已有排队记录，之后每次重排生成新唤醒 ID。撤销或取消定位当前唤醒，清除指针并保存操作历史。SQL 保证操作范围不可修改，只有预留阶段持有执行槽的发布才能安全回队。 [队列变更](https://github.com/MaLaNg116/itervane/blob/3122006/packages/control-plane/src/runtime/release-queue.ts) · [数据库迁移](https://github.com/MaLaNg116/itervane/blob/3122006/packages/control-plane/migrations/0031_formal_release_wakeup.sql)
2. `a822091` 共用执行槽、数据库时钟与 fence。普通源码消费者只能认领源码阶段。发布预留过期时，在同一事务中回队或结算取消，操作 ID 和批准版本随恢复事件保留。 [执行权与恢复](https://github.com/MaLaNg116/itervane/blob/a822091/packages/control-plane/src/runtime/coordinator.ts)
3. `91002c4` 依次锁定全局执行槽、任务、目标环境和操作。先核对 pg-boss 实际唤醒及尝试编号，再对照当前批准人授权、请求人权限、目标修订与 Registry 来源。认领与后续授权调用复用候选冻结的证据拼装逻辑，并按实际复验重新计算固定指纹。事务共同提交队列结算、环境占用、任务事件和新租约。门户及两种语言用同一事实展示已认领操作。 [认领协调器](https://github.com/MaLaNg116/itervane/blob/91002c4/packages/control-plane/src/runtime/formal-release-claim.ts) · [候选读模型](https://github.com/MaLaNg116/itervane/blob/91002c4/packages/control-plane/src/service/formal-release.ts)
4. `f2e9ab7` 用真实 PostgreSQL 验证同一消息的并发与回放、事务回滚、源码占槽、环境占用、过期 fence、丢失唤醒和取消。拒绝用例覆盖目标改版、Registry 错配、批准人重授、请求人撤权和等锁期间批准过期。`b2ce344` 注入另一条内部自洽的复验记录来验证原批准指纹失效。 [数据库验收](https://github.com/MaLaNg116/itervane/blob/b2ce344/packages/control-plane/test/integration/inspections.test.ts)
5. `a4dc318` 托管 OCI 场景新增独立原生探针，认领真实第二代候选、核对批准归档、发送心跳并交还租约。仍有待执行的同一发布操作会换用新的队列 ID，旧唤醒重放会被拒绝。 [托管探针](https://github.com/MaLaNg116/itervane/blob/a4dc318/packages/control-plane/test/native/worker-inspection.ts)

固定运行源码 `a4dc3188b17769c873e88b416217ba3ff6fde520`。TypeScript、163 项单元、70 项 Python 宿主测试和原生 Worker 打包通过。首次全量 PostgreSQL 147 项通过，复验证据负例的夹具初始化被外键拦截，更换夹具后复跑。托管源码 `0645c5989f21c96ae4a8db121e828d0f7b989a2a` 正在验证。 [PR #47](https://github.com/MaLaNg116/itervane/pull/47) · [托管原生验收](https://github.com/MaLaNg116/itervane/actions/runs/44926192666)

本批的正式阶段为预留执行权。C3-C 接入外部写入意图、同摘要 Registry 导入和结果核对。C4 与 E-D 分别进行正式 Komodo 派发与独立上线核验。 [发布执行计划](../plans/p2-e-formal-release-execution.md)
