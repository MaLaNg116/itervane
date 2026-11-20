# 011 · P2-C 发布事务与结果核对导读

- 基线为已合入 #10 的 `main`，版本 `d28a481f7c567dcd52c52ef7b1622ab25bee10ef`。
- 固定代码为 `9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579`。实现范围与正式入口条件见 [本批计划](../plans/p2-c-release-reconciliation.md) 和 [运行资格](../decisions/0001-development-and-runtime-gates.md)。

## 1. 从确认跟到操作和唤醒

`decide` 沿用 P2-B 的指纹、预期版本、所有者授权和幂等判断。新的样例确认先写决定，再以同一个 Drizzle 事务创建唯一操作并向 `release-fixture-v1` 入队。唤醒的 job ID 与操作 ID 一致，载荷只有操作 ID。并发或响应丢失后的同键重放读取已有操作。升级前的决定和拒绝决定只返回已有历史。 [确认入口](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/src/service/releases.ts#L141)、[事务入队](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/src/runtime/release-fixture-queue.ts#L10)、[提交失败回滚](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/test/integration/releases.test.ts#L320)

## 2. 从队列跟到唯一预留

`reserve` 对照 job ID 和操作 ID，重新核对冻结候选、任务、当前证据和原授权实例。取得环境锁后再读取 PostgreSQL 时间，过期或失效的确认进入 `blocked`。操作行从 `queued` 进入 `dispatching` 时发放唯一一次样例预留。部分唯一索引约束每个环境至多一个处于已预留或待核对状态的操作，迁移中的触发器保护绑定并拒绝状态回退。 [重新授权](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/src/service/releases.ts#L175)、[预留](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/src/runtime/release-rehearsal.ts#L60)、[环境占用索引](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/migrations/0008_release_operations.sql#L26)

## 3. 失联后核对实际结果

`reconcile` 读取操作账本和独立观察端口。没有证明或观察不匹配时，状态为 `reconciling` 并继续占用环境。有效观察须同时匹配操作 ID、候选指纹、环境、目标映射、镜像和配置，并证明健康与访问保护。命中后写入已接纳的观察并释放占用。预留后的撤权仍允许只读核对已经发生的结果。 [核对逻辑](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/src/runtime/release-rehearsal.ts#L89)、[重连和错误观察](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/test/integration/releases.test.ts#L395)、[跨任务环境竞争](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/test/integration/releases.test.ts#L439)

## 4. 验收

| 验证 | 结果 |
| --- | --- |
| `pnpm check` | 严格类型检查和 92 项单元测试 |
| `pnpm test:integration` | 83 项真实 PostgreSQL 17 集成测试。新增 5 项，扩展既有确认、并发、再授权和提交失败用例 |
| `pnpm test:portal` | 21 项真实浏览器用例，回归 OIDC、P1 任务和双语规则预审 |
| 存量迁移 | 在一次性测试库用 `0007` 建立候选和旧确认，升级至 `0008` 后保留二者，样例操作数和唤醒数均为零 |

先跟一次人用确认后的持久化唤醒，再核对竞争、过期与重新连接用例。测试使用签名身份、受限 PostgreSQL 账号和独立保存的可信样例观察。 [确认与唤醒](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/test/integration/releases.test.ts#L147)、[并发和幂等](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/test/integration/releases.test.ts#L217)、[等待环境锁后过期](https://github.com/MaLaNg116/itervane/blob/9ea2717b4a4d0dab1c4f59d6e8ed6dccdacbb579/packages/control-plane/test/integration/releases.test.ts#L375)

本批的预留和核对只用于可信样例，输出 `releaseEligible: false`。正式入口须取得 D2/D3 执行资格、真实复验和镜像扫描及经核验的 Komodo 目标，接入现有 Worker 的执行权、队列结算和下游实际观察。 [TS + PostgreSQL 阶段验收](../implementation-plan-v2-ts-postgresql.md)
