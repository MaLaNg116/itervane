# P3-C3-B2 · 安装健康触发的正式诊断

接续 #123 的持久化准入。装机实现固定在 `ec03757212b8ab3d9ba78df9e03b0c78fb85191d`，原生用例固定在 `628cb468eafafce79f4b0e2b375aa3df9abb6931`。 [计划](../plans/p3-c-operations-incidents.md#c3-b2-装机与原生验收) · [安装与撤销](../control-plane-health.md) · [PR #124](https://github.com/MaLaNg116/itervane/pull/124)

1. 健康样本先提交，配置了登记 ID 的 Worker 再独立核对最新证据并尝试调度。部署可只启用采样。调度读取 PostgreSQL 中的事件、当前授权和已有任务。重新装配 Worker 后依然使用同一证据链。 [循环与装配](https://github.com/MaLaNg116/itervane/blob/ec03757212b8ab3d9ba78df9e03b0c78fb85191d/packages/control-plane/src/runtime/installed-health-worker.ts#L29)
2. 同一受保护应用发布两个版本。真实停止当前容器后，由已装配的 Health Worker 写入异常样本并接收诊断，再重新装配并核对仍返回同一个任务。正式 Worker 通过真实 Whiskers 读取已登记实例，完成诊断后验证原始运行 ID、范围、回执摘要和双语 HTTP、MCP 投影。 [原生装机](https://github.com/MaLaNg116/itervane/blob/628cb468eafafce79f4b0e2b375aa3df9abb6931/packages/control-plane/test/native/worker-inspection.ts#L1146) · [触发与回执断言](https://github.com/MaLaNg116/itervane/blob/628cb468eafafce79f4b0e2b375aa3df9abb6931/packages/control-plane/test/native/health-proof.ts#L14)
3. 撤销监控登记后，真实应用 503、探针身份不可用及恢复继续记账。最终核对两条关闭的事件和一条诊断关联，登记指纹、触发样本、事件、任务和诊断运行一致。恢复批准撤销、过期和目标变化的负例仍由同一托管场景核对。 [报告闸门](https://github.com/MaLaNg116/itervane/blob/628cb468eafafce79f4b0e2b375aa3df9abb6931/.github/workflows/native-runner.yml#L220)

本地 TypeScript、253 项单元、9 项 PostgreSQL 17.12 专项、10 个托管 Bash 步骤的语法和 Git 差异检查通过。托管用例固定于 `61e01bd77c4e22010cebc2505800f4ce68f0c689`，取回的实际报告确认七次采样、两条关闭的事件和一笔关联诊断。重新装配复用原任务，撤销后继续采样，已发布实例匹配，双语 HTTP 和 MCP 回执一致，三个恢复授权负例的下游写入数均为零。原生场景使用实际 Komodo、Whiskers、Keycloak 应用探针和 PostgreSQL，模型使用确定性 Anthropic 协议夹具，控制面身份使用签名 OIDC 夹具。事件查询、关联修复及门户交互在 C3-C、C3-D 继续验收。 [托管用例](https://github.com/MaLaNg116/itervane/actions/runs/45109429084/job/137478135983) · [证据归档](https://github.com/MaLaNg116/itervane/actions/runs/45109429084/artifacts/14788903177)
