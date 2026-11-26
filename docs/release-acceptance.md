# v0.1 发布验收 / Release acceptance

同一候选的 Verification、Native Runner 和 Source Release 提供发布证据。验收回执记录完整 Git 提交、代码树、官方运行链接、独立操作回执和归档 SHA-256。 [P5 实施计划](implementation-plan-v2-ts-postgresql.md#p5-验证可靠性并形成可复现的开源交付) · [发布评测](release-evaluation.md) · [发布组件](release-components.md)

## 故障与并发回归

| 验收类别 | 用例与证据 |
| --- | --- |
| 模型与 Agent | 非法参数和成批工具调用、不增加证据的动作、无进展、模型不可用和预算耗尽。正式审计对照扫描证据，复验使用实际检查结果。 [Agent 用例](../packages/verification/test/unit/agent-delivery.test.ts) · [正式审计](../packages/verification/test/unit/formal-audit.test.ts) · [正式复验](../packages/verification/test/unit/formal-verification-agent.test.ts) |
| 调度、数据与并发 | 真库原子提交任务、运行、事件和队列项，处理取消回滚及重复投递。两个消费者竞争同一全局槽，Worker 被终止后从已发布的检查点恢复，拒绝旧栅栏并正确释放父任务等待位。健康并发按事件去重，发布和重启竞争时保留环境占用与目标绑定。 [入队和取消](../packages/control-plane/test/integration/control-plane.test.ts) · [恢复与并发](../packages/control-plane/test/integration/runtime.test.ts) · [集成场景](../packages/control-plane/test/integration/inspections.test.ts) |
| 审批与权限 | 核对暂停恢复、重复和竞争批准、批准过期与撤销、审计标识、本人确认、持续的项目权限与门户身份要求。真实参考路径核对 MCP 写身份被拒、正式审批后才产生效果。 [批准与事件](../packages/control-plane/test/integration/releases.test.ts) · [MCP 身份与作用域](../packages/control-plane/test/integration/mcp.test.ts) · [原生恢复授权](reviews/p3-c-native-restore-authority.md) |
| 下游故障与结果未知 | 异常健康与探测身份不可用保留原生结果，未核对时仍持有作用域。接管先独立读回原生状态，未确认应答保留人工核对与环境占用。恢复已确认历史版本核对镜像和新容器。 [发布故障](reviews/p2-e-protected-release-faults.md) · [重启接管](reviews/p3-c-native-restart-takeover.md) · [指定版本恢复](reviews/p5-reference-version-restore.md) |
| 隔离与不可信材料 | 独立 VM 域、凭证读取边界、作用域外路径、客户端断开、域回收和跨任务残留由宿主回归与 KVM 回执核对。仓库、日志和 Skill 内容沿用结构化读取与固定规则；导入与审计用例验证资料无法替换治理决策。 [宿主生命周期](../packages/runner/host/test_libvirt_probe.py) · [隔离 Runner](reviews/p1-d2-runner-isolation.md) · [规则导入真库用例](../packages/control-plane/test/integration/rule-packages.test.ts) · [设计 Skill 审计](reviews/p4-audit-design-guidance.md) |
| 系统恢复和安装 | 独立 PostgreSQL 恢复数据库、OCI 归档、规则与安装配置，并核对治理暂停时的匿名拒绝。另有 63 条历史迁移的升后读回，以及从源码包的冻结依赖重装与浏览器登录。 [原生冷备](reviews/p5-native-backup-recovery.md) · [历史升级](reviews/p5-reference-upgrade.md) · [归档重装](reviews/p5-source-release.md) |

## 生成固定候选的验收回执

在同一候选 commit 上取得成功的 Verification 推送运行、Native Runner 运行及 Source Release 运行。根据工作流过滤条件，未自动触发的 Native Runner 和 Source Release 可以对该固定分支手动运行。汇总从同一维护者仓库读取运行，因此覆盖 fork 需要先推送到对应仓库的受信分支。 [验证流程](../.github/workflows/verification.yml) · [原生流程](../.github/workflows/native-runner.yml) · [打包流程](../.github/workflows/source-release.yml)

在候选分支运行 Release Acceptance，填入三次运行的编号。汇总要求当前提交、分支、仓库和工作流路径匹配，并核对相关作业都已完成。下载属于成功作业的脱敏报告，复算同次三次开发和运维的独立性，校验规则与 Runbook、版本恢复、故障、冷备、升级和归档安装。 [汇总工作流](../.github/workflows/release-acceptance.yml)

将 `release-acceptance.json` 与相同提交的源码包、校验文件和许可证索引保存在发行记录中。审查记录中的迁移数、持续时间、模型口径、原生回执、故障状态和仍需人工核对的范围。成功的归档安装只取得验证环境中的身份与读取能力。托管工作流保存短期材料，发布记录可长期引用独立的验收回执。 [校验与使用](source-release.md) · [分批导读](reviews/README.md)

## English

Run Verification, Native Runner and Source Release against the release candidate on a trusted branch of the same repository. After all required jobs succeed, dispatch Release Acceptance on that branch with the three run IDs. It ties the published receipts to the commit and tree, picks artifacts made by the successful jobs, recomputes the independent reference runs, and checks the restore, backup, rule reuse, upgrade and unpacked installation results.

Keep `release-acceptance.json` with the archive and license index from the verified Source Release run. Review the model scope, timings and resource values together with the regression results. [Source release instructions](source-release.md#english) · [Release evaluation](release-evaluation.md#english)
