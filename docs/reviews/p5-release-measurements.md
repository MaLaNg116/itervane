# P5-C4 · 参考验收质量与资源导读

沿用三次参考开发与运维的原生闭环，每次保存该场景已核验的耗时、模型使用量和存储占用。 [本批计划](../plans/p5-release-measurements.md) · [评测口径及本机实测](../release-evaluation.md) · [前置 #172](https://github.com/MaLaNg116/itervane/pull/172)

1. `8a70819` 使用单调时钟度量 MCP 任务发起至受保护发布读回，以及容器停机至实际健康恢复。读取审计、修复、复验和诊断的持久化模型使用量，并核对复验结果摘要。OCI 档案字节数来自获批候选，数据库占用由实际 PostgreSQL 返回。 [开发测量](https://github.com/MaLaNg116/itervane/blob/8a70819/packages/portal/test/native/reference-release.ts) · [运维测量](https://github.com/MaLaNg116/itervane/blob/8a70819/packages/portal/test/native/reference-operations.ts)
2. `95c43b0` 扩展同一次工作流的独立性校验。只有三条开发、运维的正式回执及对应测量全部匹配时，才生成第 2 版汇总。每份回执记录费用口径，保留摘要及任务、VM、审批和运行身份。 [汇总判据](https://github.com/MaLaNg116/itervane/blob/95c43b0/fixtures/runner/reference-evidence.jq)
3. 本机在同一源码指纹上比较确定性和实际模型两条路线。Anthropic 两条短路径通过，正式审计两项中一项有独立证据通过。多步任务收到 503，按已实现的策略进入人工介入。记录协议、结果、轮次、耗时及实际返回的用量。 [评测记录](../release-evaluation.md#本机授权模型实测)

本地通过严格类型和 287 项单测。用实际 Ubuntu jq 运行一正七负，验证旧报告缺少测量、耗时或档案字节数为零、用量不符、剩余问题、模型来源错误及缺失运行均被拒绝。示例字段用于校验汇总条件，真实托管测量以发布候选的同次工作流为准。
