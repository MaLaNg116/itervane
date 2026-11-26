# P5-C5 · 最终源码发布验收导读

为同一候选收集发布所需的托管结果、摘要与质量报告。完整发布仍按 v6 蓝图验收。 [本批计划](../plans/p5-release-acceptance.md) · [前置 #173](https://github.com/MaLaNg116/itervane/pull/173)

1. `b9cf6d5` 在正式 `Verification` 的类型和单测、宿主安全边界、健康探测、真实 PostgreSQL、基础冷备及 MCP 作业完成后，记录真实 PostgreSQL 版本和集成计数。原始日志、测试请求和数据库内容留在托管环境。 [回归摘要](https://github.com/MaLaNg116/itervane/blob/b9cf6d5/.github/workflows/verification.yml)
2. `2bdd9a9` 将三次运行的 GitHub 仓库、分支、完整提交和工作流路径对齐。逐个检查成功作业，按作业时间筛选重跑后保留的同名产物，从对应归档只取固定文件。 [发布汇总工作流](https://github.com/MaLaNg116/itervane/blob/2bdd9a9/.github/workflows/release-acceptance.yml) · [运行与产物核对](https://github.com/MaLaNg116/itervane/blob/2bdd9a9/scripts/collect-release-evidence.sh)
3. `2bdd9a9` 对照源码清单、依赖许可证、归档安装和同次三次开发与运维。保留代码规则、Runbook、指定版本、真实升级、故障、备份及治理暂停时的匿名拒绝证据。最终回执携带实际发布资产的摘要和回归链接。 [回执判据](https://github.com/MaLaNg116/itervane/blob/2bdd9a9/scripts/collect-release-evidence.jq)
4. `d3a850a` 将故障与并发验证类别对应到具体用例，记录发布批次和汇总使用方式。 [验收说明](../release-acceptance.md)

在 Ubuntu 上对完整脚本进行了组合测试。从已保存的真实备份、原生运行、升级和归档回执派生测试输入，补入当前候选专属的模拟测量及版本恢复。成功样例排除了较早尝试的同名产物。不同提交、不同仓库、缺失或失败作业、错误或含糊的产物来源及归档校验不符共七项均被拒绝。另用 GitHub API 读取实际源码安装回执的 ZIP，检查固定文件名。最终同次托管回执待依赖合入后出具。

本机授权的 Anthropic 协议探测补充了正式模板修复和两种运维证据组合。修复产物通过实际摘要核对。运维按不同观察选择不同建议，未产生部署副作用。 [模型实测记录](../release-evaluation.md#本机授权模型实测)

本地严格类型、287 项单元、82 项 Linux 宿主回归和 3 项健康探针均通过。本地独立 PostgreSQL 17.12 恢复 89 张表、检查点、队列和一份试验配置，拒绝损坏或重复恢复。P0 评测命令检查了 24 个条目的定义、6 个验证集条目及可信应用的五个运行检查。真实 OCI 档案与运维回执使用原生冷备场景核对。 [原生冷备导读](p5-native-backup-recovery.md)

`a600856` 补充参考复验失败时的状态记录。失败分支读取最多四个事件，只打印任务、复验和校验后的事件代码。专项验证确认夹具中的文本和标识未进入日志，原失败仍上抛。成功条件、等待上限和 Runner 清理流程沿用原判据。 [诊断实现](https://github.com/MaLaNg116/itervane/blob/a600856d0776a724287bb97c3eb9651565f32f75/packages/portal/test/native/reference-release.ts)
