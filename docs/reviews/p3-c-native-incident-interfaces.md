# P3-C3-D3b · 健康事件原生接口联验

接续 [PR #133](https://github.com/MaLaNg116/itervane/pull/133) 和 [PR #129](https://github.com/MaLaNg116/itervane/pull/129)。原生场景固定为 `bb3954e77aefa879846fbfeac86d736da7b512ae`。 [实施计划](../plans/p3-c-native-incident-interfaces.md)

1. 沿用原场景的已发布缺陷应用，用实际 503 触发 Whiskers 只读诊断。通过正式接口比对两种语言、门户授权与 MCP 记录。停止动作须由门户身份绑定原发布确认，重放返回同一时间。接着重新采样验证事件仍在，调度因人工停止而保留原诊断任务。 [事件与停止](https://github.com/MaLaNg116/itervane/blob/bb3954e77aefa879846fbfeac86d736da7b512ae/packages/control-plane/test/native/linked-health-proof.ts#L9)
2. 外部 MCP 为同一个诊断准备修复提案。门户确认固定指纹，普通 API 身份和不同指纹被拒。确认重放引用同一个任务，HTTP 和 MCP 都能查询诊断关联、发布和固定源码。 [提案与确认](https://github.com/MaLaNg116/itervane/blob/bb3954e77aefa879846fbfeac86d736da7b512ae/packages/control-plane/test/native/linked-health-proof.ts#L93)
3. 既有原生场景继续校验隔离修复、独立 VM 复验和新候选的发布审批。托管检查还会核对停止采样顺序及最终发布任务与确认回执的一致性。 [工作流断言](https://github.com/MaLaNg116/itervane/blob/bb3954e77aefa879846fbfeac86d736da7b512ae/.github/workflows/native-runner.yml#L225)

本地 TypeScript 与工作流 Bash 语法通过。托管验证用于核对 KVM、PostgreSQL、Komodo、Whiskers、OCI 和 Keycloak 保护入口，平台身份以签名 OIDC 测试令牌区分，模型使用确定性的 Anthropic 协议夹具。浏览器交互证据见上一批。 [托管检查](https://github.com/MaLaNg116/itervane/pull/134/checks) · [Chrome 导读](p3-c-incident-portal.md)
