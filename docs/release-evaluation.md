# v0.1 发布评测与资源记录 / Release evaluation

参考验收在三个独立的干净安装中使同一合成项目完成修复、发布与恢复。汇总要求实际 PostgreSQL、Keycloak、浏览器、KVM、Komodo 与 Whiskers 的结果，核对任务、VM、原生操作、批准和受保护健康。每份报告绑定对应代码树。 [验收汇总](reviews/p5-reference-evidence.md) · [实测报告批次](reviews/p5-release-measurements.md)

## 托管报告口径

| 字段 | 观测范围 |
| --- | --- |
| `deliveryDurationMs` | 从外部 MCP 发起固定版本任务至受保护发布独立读回。包括该场景的下游准备与浏览器审批操作。 |
| `recoveryDurationMs` | 从发起合成容器停机至独立读回、事件结案及匿名健康拒绝的耗时。 |
| `findings` | 对照正式扫描和独立复验，记录新增、解决及剩余数量。参考候选要求解决一个依赖问题，新增和剩余均为零。 |
| `archiveBytes` / `databaseBytes` | 前者来自发布候选的已核验 OCI 档案，后者是此参考 PostgreSQL 数据库的实际占用。 |
| `auditUsage` / `repairUsage` / `verificationUsage` / `diagnosisUsage` | 持久化的模型轮次、工具调用与 token 数，作为该场景的运行账本。 |

托管参考场景采用固定 Anthropic 协议响应，汇总的外部模型请求数为零。报告中的 token 数对应协议夹具返回值。耗时供比较同环境的重复运行。模型的实际收费和长期资源用量由部署后的账单与监控记录。 [实施计划的评测指标](implementation-plan-v2-ts-postgresql.md)

## 本机授权模型实测

2026-11-26 在 `f1d9814` 的可信 checkout 上运行。合成场景使用固定输入，真实协议探测通过已配置的本机环回端点。表中用量为模型适配器记录值，双场景耗时为相应命令的实测总时间。 [固定源码](https://github.com/MaLaNg116/itervane/commit/f1d98146e809c6d47cb0be8bdd2fd9f25cfb911b)

| 样例 | 实际结果 | 模型用量与耗时 |
| --- | --- | --- |
| Anthropic 短工具循环 | 健康路径和故障日志路径均通过独立判据 | 分别记录 1,526 和 739 token |
| 确定性开发对照 | `display` 和 `pagination` 均完成 | 每项 13 轮、10 次工具，合计 5,965 ms |
| Anthropic 实际多步开发 | 两项均进入人工介入。独立重跑 `display` 时，回放工具结果的请求返回 HTTP 503 | 分别记录 2,697 和 2,616 token，合计 13,703 ms |
| Anthropic 正式审计合成场景 | 疑似凭证项完成，依赖项在连续无进展后进入人工介入 | 分别记录 7,776 和 7,713 token，合计 35,463 ms |
| OpenAI 协议合成诊断 | `display` 的首个请求返回 HTTP 503，任务进入人工介入 | 请求未返回用量 |

合成样例和托管记录都有独立判据。本机端点的多步表现保留为本次结果，发布材料继续以具体场景、协议和实际服务为单位。 [评测样例](../evaluation/README.md) · [模型配置](release-components.md)

## English

The hosted report covers three independent reference installs. It records actual end-to-end delivery and recovery durations, evidence-backed finding counts, the verified OCI archive size and PostgreSQL storage size. Model usage is taken from the persisted records. Hosted model responses are scripted and run without external model requests. The table above includes the observed outcomes of the separate authorized loopback model trials, including the provider errors and the formal audit that required human intervention.
