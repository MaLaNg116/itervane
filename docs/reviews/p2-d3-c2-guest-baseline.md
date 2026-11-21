# P2-D3-C2-C · 客体运行与受保护基线 Review Guide

这一批将固定候选的离线构建产物交给同一次一次性 VM 内的应用运行与独立 HTTP 检查，依赖 [客体构建 #28](https://github.com/MaLaNg116/itervane/pull/28)。首轮运行代码快照为 `e8e22426a1899ecc5b25d4f04f5dc40c1715c7ca`。 [本批实施计划](../plans/p2-d3-c2-guest-baseline.md)

## 代码导读

1. `dc397f1` 定义构建产物上的基线回执。正式复验输入只有在绑定构建 profile 时才可选用 `runStandardBaseline`。控制面检查结果、基线摘要、dist 摘要和退出证据。 [复验契约](../../packages/contracts/src/formal-verification.ts) · [Runner 回执契约](../../packages/contracts/src/qualified-verification.ts)
2. `7c01881` 让独立 Runner 控制器校验此执行资格。调用方明确请求运行基线后，仍须核对当前租约、封存镜像和精确作用域。 [控制器](../../packages/runner/host/qualified_controller.py)
3. `68e7133` 从已校验的 dist、固定后端与锁文件准备运行副本，以离线缓存安装锁定的生产依赖。应用进程和 HTTP 检查程序使用独立非 root 身份，在私有回环通信。检查结束通过 systemd 控制组和实际进程句柄核对退出。 [客体运行](../../packages/runner/host/runtime_guest.py) · [HTTP 检查入口](../../fixtures/runner/baseline-probe.mjs)
4. `3d3e969` 在 PostgreSQL 的正式复验回执上再核对冻结的请求与基线证据。回执和租约、确认及重领继续走相同的事务边界。 [迁移](../../packages/control-plane/migrations/0022_formal_standard_baseline_evidence.sql) · [数据库测试](../../packages/control-plane/test/integration/inspections.test.ts)
5. `e8e2242` 在标准构建环境中分别验证健康候选和固定的 HTTP 503 回归。复查两者的 dist 摘要、不同的运行输入摘要、检查结果、终止证据、VM 清理和回执重读。 [原生验收入口](../../packages/control-plane/test/native/worker-verification.ts)

## 验收记录

- TypeScript 检查、基线探针语法检查、Bash 脚本语法检查和 50 项 Runner 宿主测试通过。
- 119 项 PostgreSQL 集成通过，包含构建和基线回执的错绑拒绝与匹配回执的持久化重读。托管 [Verification](https://github.com/MaLaNg116/itervane/actions/runs/44894586749) 完成确定性测试、门户和扫描器三组检查。
- 固定健康候选为 `3a719ca44f306d30cdf2d27e9a6d3b954ed656f0`，健康回归候选为 `1eac5c8776c6e81613cfb5adf6edd2cd6b163ba3`。托管 KVM 验收结果待核对和归档。

后续依赖为 OCI 产物及其扫描、正式复验 Agent 集成、候选审批后的 Komodo 发布。应用私有回环中的 HTTP 检查仅覆盖固定标准应用运行范围。
