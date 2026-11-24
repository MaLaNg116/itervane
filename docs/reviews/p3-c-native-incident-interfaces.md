# P3-C3-D3b · 健康事件原生接口联验

接续 [PR #133](https://github.com/MaLaNg116/itervane/pull/133) 和 [PR #129](https://github.com/MaLaNg116/itervane/pull/129)。原生场景固定为 `bb3954e77aefa879846fbfeac86d736da7b512ae`。 [实施计划](../plans/p3-c-native-incident-interfaces.md)

1. 沿用原场景的已发布缺陷应用，用实际 503 触发 Whiskers 只读诊断。通过正式接口比对两种语言、门户授权与 MCP 记录。停止动作须由门户身份绑定原发布确认，重放返回同一时间。接着重新采样验证事件仍在，调度因人工停止而保留原诊断任务。 [事件与停止](https://github.com/MaLaNg116/itervane/blob/bb3954e77aefa879846fbfeac86d736da7b512ae/packages/control-plane/test/native/linked-health-proof.ts#L9)
2. 外部 MCP 为同一个诊断准备修复提案。门户确认固定指纹，普通 API 身份和不同指纹被拒。确认重放引用同一个任务，HTTP 和 MCP 都能查询诊断关联、发布和固定源码。 [提案与确认](https://github.com/MaLaNg116/itervane/blob/bb3954e77aefa879846fbfeac86d736da7b512ae/packages/control-plane/test/native/linked-health-proof.ts#L93)
3. 既有原生场景继续校验隔离修复、独立 VM 复验和新候选的发布审批。托管检查还会核对停止采样顺序及最终发布任务与确认回执的一致性。 [工作流断言](https://github.com/MaLaNg116/itervane/blob/bb3954e77aefa879846fbfeac86d736da7b512ae/.github/workflows/native-runner.yml#L225)

本地 TypeScript 与工作流 Bash 语法通过。托管验证用于核对 KVM、PostgreSQL、Komodo、Whiskers、OCI 和 Keycloak 保护入口，平台身份以签名 OIDC 测试令牌区分，模型使用确定性的 Anthropic 协议夹具。浏览器交互证据见上一批。 [托管检查](https://github.com/MaLaNg116/itervane/pull/134/checks) · [Chrome 导读](p3-c-incident-portal.md)

托管提交 `5b834f57212981c6af549daf096b82bd3aacb617` 通过 12 项原生检查。关联场景报告源码指纹 `b2d5cae9d7e0a414e874f67e801dd5f3b076c399fb48a6801a02e77096427560`。独立核对原异常样本、停止后的同事件 503 和新发布的两次健康采样，序列分别为 1、2、3、4。对照回执还确认门户授权、重放、实际 503 到 200 和两个 VM 的清理。 [原生运行](https://github.com/MaLaNg116/itervane/actions/runs/45365354291/job/138345542785) · [证据工件](https://github.com/MaLaNg116/itervane/actions/runs/45365354291/artifacts/14907722387)
