# P2-D3-D-C2 · 正式复验失败后的受控返修

本批以已合入的 [正式 Worker 复验 #35](https://github.com/MaLaNg116/itervane/pull/35) 为基线。平台根据已经保存并核验的失败证据决定能否返修。满足条件时，同一任务在一个事务内结束旧 run，并安排沿用固定 Git 提交的新 run。 [实施计划](../plans/p2-d3-d-repair-retry.md)

## 代码阅读顺序

1. `e9fd0fc` 固定返修证据和授权。数据库要求上一代结论、复验回执、候选、修复操作与当前执行槽对应。项目访问授权具有独立版本。请求人的授权变更后，即使再次取得同一角色，也需要重新建立后续执行授权。 [数据库迁移 0027](https://github.com/MaLaNg116/itervane/blob/e9fd0fc/packages/control-plane/migrations/0027_bounded_repair_retry.sql) · [返修契约](https://github.com/MaLaNg116/itervane/blob/e9fd0fc/packages/contracts/src/formal-repair-retry.ts)
2. `4b64650` 给修复 Agent 提供核验过的失败检查、摘要引用和上一代补丁大小等信息。固定事实通过 LangGraph 上下文传递，Agent 仍通过原有权限范围内的工具调查。 [修复角色](https://github.com/MaLaNg116/itervane/blob/4b64650/packages/agent/src/formal-repair.ts)
3. `ee8bd65` 将返修决定放在正式复验结论发布事务中。先核对已验证的失败类别和上一代补丁，再保存后继代次、写入双语事件并通过 pg-boss 入队。Worker 重领时复核请求人、规则和复验配置，并拦截相同补丁与相同候选。 [发布入口](https://github.com/MaLaNg116/itervane/blob/ee8bd65/packages/control-plane/src/service/verification-result.ts) · [返修事务](https://github.com/MaLaNg116/itervane/blob/ee8bd65/packages/control-plane/src/service/repair-retry.ts) · [Worker](https://github.com/MaLaNg116/itervane/blob/ee8bd65/packages/control-plane/src/runtime/worker.ts)
4. `8ab7513` 显式组装 `/v1/me` 的公共返回字段。首次 PostgreSQL 复跑发现新增的内部授权版本被传入严格的公共 DTO。本次修复保留原 API 契约。 [公共身份投影](https://github.com/MaLaNg116/itervane/blob/8ab7513/packages/control-plane/src/service/resources.ts)
5. `b7312e4`、`dde015f` 验证新一代任务重领、重复结果拦截、返修额度、撤权重授、策略漂移、事务回滚，以及仍存在可修复源码发现的分支。 [真实数据库场景](https://github.com/MaLaNg116/itervane/blob/dde015f/packages/control-plane/test/integration/inspections.test.ts)
6. `4b0abdf` 增加托管 KVM 双代次验收。脚本化 Provider 第一轮提交能通过扫描但会导致 503 的补丁，第二轮读取已核验失败后给出不同补丁。正式 Worker 负责扫描、应用补丁、运行基线和留存镜像，由独立读取器对照最终归档。 [固定合成样例](https://github.com/MaLaNg116/itervane/commit/39e9b7f34fdd01ec55fe4dda5358ffce5d68cbf8) · [原生验收入口](https://github.com/MaLaNg116/itervane/blob/4b0abdf/packages/control-plane/test/native/worker-inspection.ts)

## 验收与边界

- 本机完成 TypeScript、163 项单元、真实 PostgreSQL 17 的 135 项集成测试及原生验收脚本语法检查。135 项集成测试包含受控返修的六个新增场景。其后加入的源码发现用例正在随全量数据库测试复跑。
- 两代次正式 Worker 的托管 KVM 验收随本批 PR 单独执行。预期第一代实际返回 503，第二代恢复基线并产生可独立回读的 OCI 制品。两代候选的补丁和源码清单均需核对。
- 每个任务最多自动返修一次。原稿还没有已核验修复件、缺少可操作证据、隔离清理结果不明、授权改变或返修用尽时，任务保留人工处理或核对状态。
- D-D 提供双语门户和外部 MCP 的复验结果与历史。P2-E 继续核对当前候选与镜像，通过真实人工批准后交给 Komodo。
