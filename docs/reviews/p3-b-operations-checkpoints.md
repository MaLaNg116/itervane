# P3-B3c1 · 正式诊断检查点 Review Guide

[草稿 #78](https://github.com/MaLaNg116/itervane/pull/78) 接续 [证据预留 #77](https://github.com/MaLaNg116/itervane/pull/77)。领域约束和检查点代码固定在 `d3adacfacdf6a102e952ff3aaffeca344959b28c`。 [实施计划](../plans/p3-b-operations-checkpoints.md)

1. 从 `operations_diagnosis_runtime` 开始。发布指针唯一关联冻结输入，PostgreSQL 核对任务角色、当前代次、登记和租约，只允许推进到新的检查点。 [迁移](https://github.com/MaLaNg116/itervane/blob/d3adacfacdf6a102e952ff3aaffeca344959b28c/packages/control-plane/migrations/0042_operations_diagnosis_checkpoint.sql)
2. 看 `GuardedCheckpointer.publication`。读写重验当前权限、发布容器、冻结输入和模型指纹。运维检查点使用独立线程，恢复仅采用领域指针和已确认的中间写入。Worker 退出期间保存的原始检查点也要经领域事务发布。 [检查点](https://github.com/MaLaNg116/itervane/blob/d3adacfacdf6a102e952ff3aaffeca344959b28c/packages/control-plane/src/runtime/checkpointer.ts#L68)
3. 看 PostgreSQL 测试。一个可信 ReAct 样例在容器状态已持久化、图还未收到观察结果时更换 Worker，接管后复用该记录，继续采集指标和发布历史，重连再次读到相同结论。 [接管与重放](https://github.com/MaLaNg116/itervane/blob/d3adacfacdf6a102e952ff3aaffeca344959b28c/packages/control-plane/test/integration/inspections.test.ts#L2513)

本机 TypeScript、223 项单元及 PostgreSQL 17.12 专项八项通过。覆盖未发布数据隔离、输入或模型变化、执行权过期、取消、撤权、换绑、证据重放和审计与修复检查点回归。Drizzle 生成检查无差异。 [托管检查](https://github.com/MaLaNg116/itervane/actions/runs/44977332199) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/44977332136)

B3c2 接续正式 Worker 与领域结算。B3d 验收真实 Whiskers 和双语报告的端到端流程。P3-C 接续获批处置与恢复验证。
