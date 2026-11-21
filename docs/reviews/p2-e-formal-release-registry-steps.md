# P2-E-C3-C1 · 归档步骤与 Registry 导入意图

基于正式队列认领与可恢复租约。 [PR #47](https://github.com/MaLaNg116/itervane/pull/47) · [发布步骤计划](../plans/p2-e-formal-release-registry-steps.md)

1. `6a2dd06` 增加 Registry 只读核对。导入与只读查询共用已批准来源、仓库和镜像摘要的校验。查询在执行权校验之间读取实际 manifest 和配置原始字节，并复用既有独立摘要校验。归档删除后仍可核对 Registry，缺少或不一致的证据不能登记成功。 [Registry 适配器](https://github.com/MaLaNg116/itervane/blob/6a2dd06/packages/control-plane/src/runtime/release-registry.ts) · [托管探针](https://github.com/MaLaNg116/itervane/blob/6a2dd06/packages/control-plane/test/native/release-archive.ts)
2. `bcf7b06` 增加步骤账本和具体状态转换。归档按操作和 fence 编号，只有当前租约下的归档凭据能支持唯一的 Registry 导入意图。对同一操作保存准备、待核对和匹配的结果。写入意图和双语事件同事务提交。发布取消后仍允许已持有的同一操作登记核对事实，原始取消状态继续约束新的外部写入。 [步骤服务](https://github.com/MaLaNg116/itervane/blob/bcf7b06/packages/control-plane/src/runtime/formal-release-steps.ts) · [迁移与数据库守卫](https://github.com/MaLaNg116/itervane/blob/bcf7b06/packages/control-plane/migrations/0032_formal_release_steps.sql)
3. `24a0b04` 对照 PostgreSQL 拒绝跳过归档、陈旧 fence、跨操作与错配凭据，确认竞争导入意图只有一个成功，取消后只登记已绑定的核对结果。 [集成验收](https://github.com/MaLaNg116/itervane/blob/24a0b04/packages/control-plane/test/integration/inspections.test.ts)

固定源码 `d8666cf4ed3b1ee6776eb34952756149caf10a25`。TypeScript、163 项单元及原生 Worker 打包通过。本机非 root 的 Distribution 3.1.2 试验验证缺失返回、导入后清理暂存、独立回读、来源或配置不符与读后失去执行权。真实仓库是专用临时 Registry。

步骤账本专项在 PostgreSQL 17.12 通过。全量数据库验收和托管 OCI 证据随本批 PR 更新。

C3-C2 接线正式 Worker 的传输、导入和待核对调度，让新 fence 能用原始导入意图恢复只读核对。完整发布继续等待 Komodo 与运行版本独立验收。
