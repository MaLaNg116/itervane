# P2-E-A2 · 正式发布候选的冻结与查阅

基于 [归档读取 #39](https://github.com/MaLaNg116/itervane/pull/39)。本批将当前复验的源码、OCI、规则与已登记的发布目标固定为一份候选，任务进入待人工决定状态。 [P2-E 实施计划](../plans/p2-e-formal-release.md)

1. `64cc0c1` 在受保护环境下登记 Komodo 部署和服务器 ID、相对镜像仓库名、运行配置指纹、当前复验 profile 指纹及上线验证和恢复方案指纹。相同文档按摘要重放，真实变更递增目标版本。数据库限制一个部署 ID 只绑定一个环境。 [登记服务](https://github.com/MaLaNg116/itervane/blob/64cc0c1/packages/control-plane/src/service/release-targets.ts) · [迁移 0029](https://github.com/MaLaNg116/itervane/blob/64cc0c1/packages/control-plane/migrations/0029_formal_release_candidates.sql)
2. `aa3a21c` 用正式复验读取器验证当前代次、检查点、结果、Runner 回执及归档读取证明。冻结入口只接受 `environmentId` 与 `expectedVersion`。候选、任务状态与审计事件同事务提交。重复请求返回同一候选。目标变化后，旧候选继续可查并标记 `evidence_changed`。 [HTTP 入口](https://github.com/MaLaNg116/itervane/blob/aa3a21c/packages/control-plane/src/api.ts) · [冻结与读取](https://github.com/MaLaNg116/itervane/blob/aa3a21c/packages/control-plane/src/service/formal-release.ts)
3. `fab7d85` 覆盖并发冻结、事件写入回滚、归档长度错配、跨项目、只读成员与撤权。目标策略加严时拒绝候选，恢复原配置后目标版本仍递增，需要冻结新候选。托管环境使用第二代真实 KVM 回执验收冻结。 [数据库场景](https://github.com/MaLaNg116/itervane/blob/fab7d85/packages/control-plane/test/integration/inspections.test.ts) · [原生流程](https://github.com/MaLaNg116/itervane/blob/fab7d85/packages/control-plane/test/native/worker-inspection.ts)
4. `dcecd48` 修正正式候选等待决定时沿用样例文案的问题。以正式任务事件文案统一中英文 API 状态，并在集成测试断言显示值。 [正式文案](https://github.com/MaLaNg116/itervane/blob/dcecd48/packages/control-plane/src/service/formal-release.ts)

安装维护者通过 `pnpm register:release-target <目标配置 JSON>` 登记目标。配置字段以 `formalReleaseTargetSchema` 为准。默认阻断严重、高和严重度未知的镜像发现，冻结窗口 30 分钟，正式复验最多使用 24 小时。候选有效期取两个期限的较早值。 [目标契约](https://github.com/MaLaNg116/itervane/blob/64cc0c1/packages/contracts/src/release.ts)

本机 TypeScript、九项真实 PostgreSQL 专项通过，修正文案后固定 `dcecd48845570e4bae79fd313bceb5b98d81a2c4` 完成 138 项全量集成。最终数据库测试源码指纹为 `43654b08f1bf0e01c9dad8b02dd5e443a48fb4d3a56839f27863be0a9594600f`。 [托管 KVM 验收](https://github.com/MaLaNg116/itervane/actions/runs/44913906085)

托管 KVM 四组全绿。标准 OCI 路径在第二代复验后冻结正式候选，已核对候选代次、复验结果、回执、补丁和归档指纹。独立回读确认归档 79,042,560 字节、SHA-256 `8e565281028ffcf08ea3d31b8d0bacb64af51db53e3164d8620288f30d636636`，镜像 manifest 一致且工作区与传输暂存已清理。#40 以 `8f49fac09568d76f4fbcc05d2ba66a5e495824dd` 合入 main。 [PR #40](https://github.com/MaLaNg116/itervane/pull/40)

原生验收使用声明式测试目标。E-B 接入本人确认、有效期和正式队列事务。E-C 按目标版本派发并核对真实 Komodo。
