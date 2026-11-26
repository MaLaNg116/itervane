# P5-C1 · 参考运行独立性与回执导读

三个矩阵作业各自从空环境开始。它们产出自己的开发发布和运维恢复报告，供一次独立汇总读取。 [本批计划](../plans/p5-reference-evidence.md) · [前置 #167](https://github.com/MaLaNg116/itervane/pull/167)

1. `cb6a3f9` 在全部原生验收成功后，从当前工作流 ID 下载三个明确命名的报告。凭据仅用于读取该工作流产物。独立作业用当前 Git 树核对每份报告。 [托管汇总](https://github.com/MaLaNg116/itervane/blob/cb6a3f9/.github/workflows/native-runner.yml)
2. `cb6a3f9` 核对单次报告的真实服务、审批、恢复与作用域，并比较三个项目、六个任务与运行、六个初检或复验域、三个发布和三个恢复。原生批准和运行更新编号必须分别唯一。产物摘要保留场景、运行计数以及相应回执坐标。 [核对谓词](https://github.com/MaLaNg116/itervane/blob/cb6a3f9/fixtures/runner/reference-evidence.jq)

本地用实际 jq 运行正反样例，验证匹配的三份报告通过，缺少一个场景、混入另一棵 Git 树、重复使用 VM 或批准编号都被拒绝。托管汇总出具后再将其列入发布验收。代码规则、故障并发、备份恢复和安装发布材料仍按 P5 总体验收核对。 [P5 发布出口](../implementation-plan-v2-ts-postgresql.md#p5-验证可靠性并形成可复现的开源交付)
