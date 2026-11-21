# P2-E-C4-B · 正式 Komodo 派发与恢复导读

基于版本化目标和受限适配器的 [PR #50](https://github.com/MaLaNg116/itervane/pull/50)。 [分批计划](../plans/p2-e-formal-komodo-ledger.md)

## C4-B1 的 Registry 前置条件

`5678ce5ba49ba01a3f23c2316132e9b9671b2e87` 中的 `FormalReleaseSteps.readRegistryProof` 同时核对当前阶段与已确认证据。步骤表保留旧证据，供审计和比对。曾完成核验的进程失去租约后，接续者先进入待核对并回读；新租约完成核对后，该方法再返回证明。

## C4-B1 的两条 Komodo 步骤

固定源码 `05aea46a13e53fba6a8d3c135efb1b5916989379`，基于 #50 的目标契约及原生适配器。 [PR #51](https://github.com/MaLaNg116/itervane/pull/51)

1. `5e9fcb7` 在原步骤表上补充两类唯一意图。配置意图绑定服务身份、目标版本、运行配置、Registry 实际镜像与原镜像引用摘要。原镜像引用留在调用内存中。部署派发复用已确认的配置意图。迁移约束保证同一 Core 的原生更新 ID 不会被绑定给其他发布。 [迁移和写入约束](https://github.com/MaLaNg116/itervane/blob/05aea46a13e53fba6a8d3c135efb1b5916989379/packages/control-plane/migrations/0034_formal_release_komodo_steps.sql)
2. `6e490c5` 在批准和租约有效时准备配置或派发，并在网络写前核对当前步骤。配置需独立回读，派发先记录原生更新 ID，再独立读回终态。撤销批准会停止新的写入，仍可记录该租约已放行的请求结果。双语任务事件和发布页共用当前阶段。 [领域步骤](https://github.com/MaLaNg116/itervane/blob/05aea46a13e53fba6a8d3c135efb1b5916989379/packages/control-plane/src/runtime/formal-komodo-steps.ts) · [执行权](https://github.com/MaLaNg116/itervane/blob/05aea46a13e53fba6a8d3c135efb1b5916989379/packages/control-plane/src/runtime/formal-release-claim.ts)
3. `05aea46` 的真实 PostgreSQL 专项验证同一操作并发只登记一次，旧租约与 Registry 观察权不能获得 Komodo 写入权，错配配置与更新 ID 被拒绝，撤权后仍能记录并核对已有结果。两种语言的事件均核对。 [专项测试](https://github.com/MaLaNg116/itervane/blob/05aea46a13e53fba6a8d3c135efb1b5916989379/packages/control-plane/test/integration/inspections.test.ts)

TypeScript、178 项单元、真实 PostgreSQL 17.12 的三项专项与 154 项全量通过。数据库验收的源码指纹为 `5789167b273d4e4d06657be63d8c8d105784895a543dd1ac8cca7cbe55a03458`。同一运行源码的原生 Komodo 六项回归也通过，报告中的适配器更新 ID 独立，实际容器镜像与同版样例摘要一致。 [原生 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/44935345371)

四组托管 Runner 回归及常规 CI 均通过。OCI 报告中的源码指纹与 PostgreSQL 全量结果一致，实际 Registry 镜像及归档与获批候选匹配，只读观察使用新 fence，导入意图保持一条。复核版本 `f93b5ff6092fada609ee8fcdb03b781428c8b25f` 已合入主分支。C4-B2 接续真实 Worker 和跨租约只读核对。 [托管 Runner](https://github.com/MaLaNg116/itervane/actions/runs/44935345510) · [合并提交](https://github.com/MaLaNg116/itervane/commit/23e760b42b9589dd0f8f7699dfbe9ce888549186)
