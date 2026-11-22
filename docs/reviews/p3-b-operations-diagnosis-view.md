# P3-B3d1 · 双语诊断查询 Review Guide

[草稿 #80](https://github.com/MaLaNg116/itervane/pull/80) 接续 [诊断 Worker #79](https://github.com/MaLaNg116/itervane/pull/79)。实现与测试固定在 `c805a6f0d3688351cdb798b8844910bb330c7cba`。 [实施计划](../plans/p3-b-operations-diagnosis-view.md)

1. 看 `operationsObservationViewSchema`。成功诊断可返回假设、建议与四类证据。日志只输出统计，容器、日志和指标投影去除宿主及容器定位信息。普通观察仍使用原有字段。 [返回契约](https://github.com/MaLaNg116/itervane/blob/c805a6f0d3688351cdb798b8844910bb330c7cba/packages/contracts/src/operations-diagnosis.ts#L94)
2. 看 `readOperationsDiagnosisView`。查询继承当前项目权限，核对原任务、冻结输入、检查点、事件和逐项读取指纹。语言影响结论文字，事实和引用与同一份结算绑定。 [领域查询](https://github.com/MaLaNg116/itervane/blob/c805a6f0d3688351cdb798b8844910bb330c7cba/packages/control-plane/src/service/operations-diagnosis-view.ts#L10)
3. 看 HTTP 与 MCP 的共用验收。提交、Worker、结算和两种查询共用一个真实数据库。验收覆盖历史目标重映射、事件摘要不匹配、凭证及定位字段隔离、当前撤权和旧观察报告兼容。 [集成场景](https://github.com/MaLaNg116/itervane/blob/c805a6f0d3688351cdb798b8844910bb330c7cba/packages/control-plane/test/integration/inspections.test.ts#L3062)

本机 TypeScript、223 项单元及 PostgreSQL 17.12 专项五项通过。正式 Worker 使用脚本模型及固定 Whiskers 协议响应。 [托管检查](https://github.com/MaLaNg116/itervane/actions/runs/44978641612) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/44978641748)

B3d2 接续门户详情、安装配置及正式任务的原生 Whiskers 验收。
