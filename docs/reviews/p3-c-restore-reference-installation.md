# P3-C2d4c3d · 自托管指定版本恢复导读

本批接续 #119，固定代码为 `069db6cd2a2c765132325a233f4afc6bcad87b25`。 [阶段计划](../plans/p3-c-operations-restore.md) · [安装说明](../control-plane-restore.md) · [PR #120](https://github.com/MaLaNg116/itervane/pull/120)

1. 正式 API 只有在显式设置 `ITERVANE_RESTORE_API_ENABLED=1` 时组装恢复提交。监听前用同一 PostgreSQL 事务核对实际受保护环境、门户客户端、正式诊断、运维登记与注册的发布映射。恢复与重启各自校验权限并共享登记范围。 [配置](https://github.com/MaLaNg116/itervane/blob/069db6cd2a2c765132325a233f4afc6bcad87b25/packages/control-plane/src/config.ts#L37) · [启动校验](https://github.com/MaLaNg116/itervane/blob/069db6cd2a2c765132325a233f4afc6bcad87b25/packages/control-plane/src/runtime/installed-api.ts#L14)
2. PostgreSQL 专项验证默认关闭的 404、错误登记拒绝启动、已批准的人类门户提交和撤销、并发幂等、变更后拒绝。Restore Worker 独立注入 Komodo 写身份、读身份及入口探针凭证。 [真库断言](https://github.com/MaLaNg116/itervane/blob/069db6cd2a2c765132325a233f4afc6bcad87b25/packages/control-plane/test/integration/inspections.test.ts#L3052)
3. 托管场景通过与自托管命令相同的 API 启动路径接通恢复，继续使用原有隔离 Runner、实名审批和原生回读，覆盖成功、接管、授权失效、中英文 HTTP/MCP 回执。 [原生启动接线](https://github.com/MaLaNg116/itervane/blob/069db6cd2a2c765132325a233f4afc6bcad87b25/packages/control-plane/test/native/worker-inspection.ts#L950)

TypeScript、249 项单元、六项 PostgreSQL 17.12 专项和差异检查通过。托管装机与故障回归的实证由下方检查保存。 [托管检查](https://github.com/MaLaNg116/itervane/pull/120/checks)
