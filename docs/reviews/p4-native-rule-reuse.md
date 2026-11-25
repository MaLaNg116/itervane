# P4-D2c · 第二个登记项目复用已发布规则

本批沿用连续健康故障的诊断、修复和真实规则发布。完成发布后为第二个项目登记单独的仓库记录、应用和发布目标。两组源码共用测试 Git 服务和标准构建依赖锁，各任务固定自己的源码提交。 [本批计划](../plans/p4-native-rule-reuse.md) · [#152](https://github.com/MaLaNg116/itervane/pull/152)

1. 两个固定文件版本把健康响应放在 `server/readiness.mjs`，使用新的接收对象。`10e9578` 固定返回 503，`3575136` 按模式决定状态码。对照版本保留原构建画像接受的依赖字节。 [命中样例](https://github.com/MaLaNg116/itervane/blob/10e95785b608fff1a231c10d8f5ee02efb4cc6a9/server/readiness.mjs) · [正常反例](https://github.com/MaLaNg116/itervane/blob/35751364b222c229a7969decafaa7d35fedc86e7/server/readiness.mjs)
2. `2f10817` 通过外部 MCP 收件，核对 PostgreSQL 固定的包版本、审核摘要、激活序号及初检回执。核对中英文与 HTTP/MCP 读回，审计轨迹必须引用 Semgrep 回执。命中任务转人工并拒绝冻结发布，正常反例经独立 VM 复验后可以冻结正确目标的候选。候选要求门户审批，并检查实际下游目标保持待部署状态。 [任务与回执](https://github.com/MaLaNg116/itervane/blob/2f10817/packages/control-plane/test/native/published-rule-reuse.ts) · [托管场景](https://github.com/MaLaNg116/itervane/blob/2f10817/packages/control-plane/test/native/worker-inspection.ts)
3. `2620a29` 核对跨项目绑定、扫描结果、独立域和清理回执、目标与发布审批。由主机重新计算第三份 OCI 归档摘要并核对清理。 [工作流判据](https://github.com/MaLaNg116/itervane/blob/2620a29/.github/workflows/native-runner.yml) · [归档核验](https://github.com/MaLaNg116/itervane/blob/2620a29/fixtures/runner/run-qualified-session.sh)

本地 TypeScript、287 项单测、托管入口打包和 Bash 语法核对通过。Linux 固定 Semgrep CE 1.170.0 对这两份实际源码分别得到 1 次和 0 次命中。 [证据索引](README.md)

托管 `45537744366` 在提交 `0c672c45f9d36d1b5272d0c562486972ac9b1696` 上完成全部 13 项原生作业。`protected-release-linked-health` 的 PostgreSQL 17.12 账本证明工作区规则 `literal-health-error-response` 真实发布后，在第二个登记项目使用同一激活序号、审核与版本。正例命中 `server/readiness.mjs` 并转人工，反例的初检及独立 KVM 复验均为零命中。归档 SHA-256 为 `f39f8fea4ac3d3a96d3615c0ec89fd628505d161b0c4bf28cba02b7c86c26a0e`，三个扫描域均确认清理。Komodo、受保护入口和签名身份参与验收，模型使用 Anthropic 协议夹具。第二个项目的发布候选停在门户等待审批。 [托管作业](https://github.com/MaLaNg116/itervane/actions/runs/45537744366/job/138948411773)
