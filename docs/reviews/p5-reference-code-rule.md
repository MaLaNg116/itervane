# P5-B7 · 参考安装中的代码规则复用导读

本批在新的参考安装中部署固定应用，采集真实健康故障，确认关联修复并独立复验。再用这个案例学习代码规则，审核发布后在第二个项目验证。 [本批计划](../plans/p5-reference-code-rule.md) · [前置 #168](https://github.com/MaLaNg116/itervane/pull/168)

1. `79678ad` 共用 Runbook 和代码规则的案例、候选、验证与审核入口。代码规则要求真实健康复验从 503 到 200，并逐个检查实际 Semgrep VM 中的命中、修正和相似样例。 [提炼与验证](https://github.com/MaLaNg116/itervane/blob/79678ad/packages/portal/test/native/reference-learning.ts)
2. `1900f4c` 使用同一次实际 Keycloak、PostgreSQL、KVM、Registry 与受保护入口。健康 Worker 观察发布后的固定故障。正式 Agent 用 Whiskers 证据诊断，维护者从门户停止自动诊断并批准关联修复。核对原始样本、受限补丁、单独复验域、再次审批和新发布的实际健康。 [健康与关联修复](https://github.com/MaLaNg116/itervane/blob/1900f4c/packages/portal/test/native/reference-code-rule.ts) · [受保护发布](https://github.com/MaLaNg116/itervane/blob/1900f4c/packages/portal/test/native/reference-release.ts)
3. `1900f4c` 用发布后的现行规则处理第二项目的固定正反任务。核对规则版本、两种语言下的读回、Semgrep 与审计证据。命中任务阻断发布，干净任务的独立复验可以冻结候选并等待人工批准。读取独立 Komodo 目标确认该候选尚未部署。 [规则复用验收](https://github.com/MaLaNg116/itervane/blob/1900f4c/packages/portal/test/native/reference-code-rule.ts)
4. `269e93b` 使用标准 Web 模板的固定输入与 Semgrep 镜像，在独立托管环境要求六个不同 VM 回执，分别覆盖故障复现、修复后复验、规则样例、两次正式检查及干净任务的复验。 [托管判据](https://github.com/MaLaNg116/itervane/blob/269e93b/.github/workflows/native-runner.yml)

本地通过 TypeScript、单元回归、门户构建、基础参考安装、Shell 语法和托管谓词正反样例。托管环境使用实际服务和 KVM，模型用脚本化 Anthropic HTTP 响应驱动正式 Agent。完整链路以本批托管产物验收。
