# P5-B5 · 参考环境健康事件与受控恢复导读

本批在当次真实发布之后登记健康检查和 Whiskers，停止测试环境中已核对的容器，验证生产 Worker 的自动诊断和双重批准。 [实施计划](../plans/p5-reference-operations.md) · [前置 #165](https://github.com/MaLaNg116/itervane/pull/165) · [自托管重启](../control-plane-restart.md)

1. `c167843` 复用可信登记命令，写入当前发布目标的 Whiskers 读面、重启安装及健康事件授权。API 用相同端口和当次真实 Keycloak 配置重启。诊断、健康与执行进程各取自己的凭证，Komodo 独立读身份与发布写入身份不同。 [登记](https://github.com/MaLaNg116/itervane/blob/c167843/packages/portal/test/native/reference-registration.ts) · [运行配置](https://github.com/MaLaNg116/itervane/blob/c167843/packages/portal/test/native/reference-operations.ts)
2. `c167843` 先观察健康，再停已绑定容器。真实 Health Worker 记录停机并事务派发，诊断 Agent 根据原生 Whiskers 的容器与发布事实推荐重启。Chrome 冻结提案、确认和排队。容器保持停止直到 Whiskers Operator 批准且门户确认继续。复盘核对当前发布、原生批准号、执行和读取租约、恢复摘要、同一容器的新启动时间、入口保护和业务槽释放。 [恢复验收](https://github.com/MaLaNg116/itervane/blob/c167843/packages/portal/test/native/reference-operations.ts)
3. `5ec1de0` 每次从纯净参考安装启动，独立保留发布、健康样本、事件、诊断、审批与恢复标识。运行记录比较真库、Chrome、真实外部 MCP 与 Whiskers 原生审计。模型使用脚本化 Anthropic HTTP 响应，服务使用真实 PostgreSQL、Keycloak、KVM、Registry、Komodo、受保护入口和 Whiskers。 [托管工作流](https://github.com/MaLaNg116/itervane/blob/5ec1de0/.github/workflows/native-runner.yml)

本地通过严格类型、287 项单测、健康和重启 Worker 打包、Shell 语法与验收谓词的正反样例。实际运行次数按托管环境生成并核验的证据计数。指定版本恢复、参考环境学习复用及发布汇总仍在后续批次核对。
