# P3-C3-C3c · 受保护应用的故障修复原生联验

接续 #128。Anthropic 协议夹具固定为 `5a5baff4ff855ff4e90ee6e5e4874aa5e9b399b1`，装机联验固定为 `814513978bdebdb333ac1821dd2b2fbb140d8568`。 [实施计划](../plans/p3-c-native-linked-health.md) · [PR #129](https://github.com/MaLaNg116/itervane/pull/129)

1. 托管环境发布固定合成应用，首次健康检查成功。已安装健康 Worker 通过受保护入口取得随后发生的同版本 503，记录触发样本并调度诊断。Agent 通过只读 Whiskers 获取当前状态和归类后的真实错误日志，核对已发布版本后提出代码排查。 [故障源码](https://github.com/MaLaNg116/itervane/commit/5d72c2fd9558d708441dc258496842698b09f630) · [运行联验](https://github.com/MaLaNg116/itervane/blob/814513978bdebdb333ac1821dd2b2fbb140d8568/packages/control-plane/test/native/worker-inspection.ts#L1108)
2. 严格核对提案与原故障样本、发布和提交。普通 API 身份和错误指纹均被拒绝，同一门户确认重放返还同一任务。随后用正式 Worker 运行审计、复现、限定路径修复和复验，旧版 503 与新版 200 来自不同 VM。实际导出的补丁、分析读取的回执和最终候选摘要应一致。 [人类确认](https://github.com/MaLaNg116/itervane/blob/5a5baff4ff855ff4e90ee6e5e4874aa5e9b399b1/packages/control-plane/test/native/linked-health-proof.ts#L9) · [故障修复模型夹具](https://github.com/MaLaNg116/itervane/blob/5a5baff4ff855ff4e90ee6e5e4874aa5e9b399b1/packages/control-plane/test/native/audit-provider.ts#L72)
3. 以独立的人工批准发布修复后的镜像，核对两次 Komodo 更新、镜像摘要和容器版本。再通过健康 Worker 获取针对新实例的两次 200，确认旧事件随发布替换关闭。宿主独立重算两份实际 OCI 工件，要求任务、进程、容器及暂存目录完成清理。 [恢复核对](https://github.com/MaLaNg116/itervane/blob/814513978bdebdb333ac1821dd2b2fbb140d8568/packages/control-plane/test/native/worker-inspection.ts#L1203) · [工件断言](https://github.com/MaLaNg116/itervane/blob/814513978bdebdb333ac1821dd2b2fbb140d8568/.github/workflows/native-runner.yml#L226)

本地 TypeScript 与托管工作流语法验证通过。完整原生场景随 PR 接受托管验收。该场景使用真实 KVM、PostgreSQL、OCI Registry、Komodo、Whiskers 和 Keycloak 保护入口，平台登录使用签名 OIDC 夹具，Agent 使用真实 Anthropic 协议适配器及确定性模型。提案确认走正式领域服务，C3-D 将同一能力开放给双语门户和外部 MCP。 [托管检查](https://github.com/MaLaNg116/itervane/pull/129/checks)

首轮已执行到复现、修复与复验结果比对。检查发现旧断言把续测失败归入常规基线失败，并漏掉 Agent 对镜像未生成状态的读取。补正后按实际基线回执判断完整观察顺序。 [首轮运行](https://github.com/MaLaNg116/itervane/actions/runs/45129684390/job/137542086519)
