# P4-D2b4b · 已发布规则复验与发布裁决

本批让正式任务把独立规则重扫纳入发布资格。围绕任务审计回执、独立 VM 的目标清单和人工审批查看。 [本批计划](../plans/p4-published-verification-result.md) · [#151](https://github.com/MaLaNg116/itervane/pull/151)

1. `1d82ace` 用同一规则快照、引擎和语言覆盖比较审计原稿与复验目标。按规则和文件计数新增、已解决与剩余命中。缺失回执、工具失败和相同清单的测量结果矛盾会得到不可验证结论。 [规则扫描比较](https://github.com/MaLaNg116/itervane/blob/1d82ace/packages/runner/src/verification-scan-comparison.ts)
2. `737b70e` 在现有执行租约下从任务固定的包版本重建复验命令，接收原稿或修复候选的独立回执。发布裁决与历史读回均用留存的原始检查证据重算。干净结果可以冻结发布候选，仍需原有的人审才能执行。 [复验输入](https://github.com/MaLaNg116/itervane/blob/737b70e/packages/control-plane/src/runtime/verification-input.ts) · [发布前复算](https://github.com/MaLaNg116/itervane/blob/737b70e/packages/control-plane/src/service/verification-result.ts)
3. `ef0cde0` 在 0079 迁移中约束复验输入的快照和初检回执摘要、独立 VM、最终目标摘要及复验规则集。沿用旧复验载荷上限，含规则证明的回执有单独的有界上限。 [迁移](https://github.com/MaLaNg116/itervane/blob/ef0cde0/packages/control-plane/migrations/0079_published_verification_evidence.sql)
4. `ef32db0` 用已审核发布的规则走四条真库路径。干净原稿允许冻结候选，规则超时留下不可验证回执，缺失证明进入对账，修复候选出现新命中时停止发布。撤回后读回原干净结果，仍按固定的审计输入计算。 [回归场景](https://github.com/MaLaNg116/itervane/blob/ef32db0/packages/control-plane/test/integration/inspections.test.ts)

本地通过 TypeScript、Drizzle 检查、287 项单测和 PostgreSQL 17.12 的 5 项专项。真库用例使用受控 Anthropic 协议模型适配器与 Runner 回执夹具。前置 #151 的托管试验在 `483a971594e8a73d14040ec84fa97c8c1fe23a36` 上使用真实 Semgrep CE。它在不同 VM 中对 4 个文件初检和复验，两次都命中 `server/app.mjs`，清理和只读会话均有回执。第二个登记项目采用真实发布的规则并走完任务验收，由下一批覆盖。 [前置规则样例作业](https://github.com/MaLaNg116/itervane/actions/runs/45533074208/job/138932944075)
