# P3-B3c2 · 正式诊断 Worker 与结算 Review Guide

[草稿 #79](https://github.com/MaLaNg116/itervane/pull/79) 接续 [诊断检查点 #78](https://github.com/MaLaNg116/itervane/pull/78)。实现与测试固定在 `0d440443f4eba393d24daab4515193ffa336769d`。 [实施计划](../plans/p3-b-operations-diagnosis-worker.md)

1. 看 Worker 的运维分支。已接收的任务模式和模型指纹限定领取。宿主按预留操作复核租约、权限和目标，调用 Whiskers 只读工具或已核验发布账本。模型获得类型化状态和脱敏汇总。 [正式调查](https://github.com/MaLaNg116/itervane/blob/0d440443f4eba393d24daab4515193ffa336769d/packages/control-plane/src/runtime/formal-operations.ts#L41)
2. 看 `publishOperationsDiagnosis`。它逐一核对图检查点、观察、工具动作与已记录证据，以确定性规则复算建议。结论、观察回执、成功事件和释放执行槽在同一事务提交。 [结算](https://github.com/MaLaNg116/itervane/blob/0d440443f4eba393d24daab4515193ffa336769d/packages/control-plane/src/runtime/operations-diagnosis-result.ts#L13) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/0d440443f4eba393d24daab4515193ffa336769d/packages/control-plane/migrations/0043_operations_diagnosis_settlement.sql)
3. 看三个新 PostgreSQL 场景。运行中容器的调查读取指标，退出容器的调查读取日志并生成重启复核建议。成功事件写入失败后，原事务回滚，后继 Worker 复用已经完成的调查。换绑场景阻断仍在返回的证据。 [真库验收](https://github.com/MaLaNg116/itervane/blob/0d440443f4eba393d24daab4515193ffa336769d/packages/control-plane/test/integration/inspections.test.ts#L2626)

本机 TypeScript、223 项单元、PostgreSQL 17.12 专项十项及迁移一致性通过。专项使用可信脚本模型与固定 Whiskers 协议响应。状态原因提供中英文。 [托管检查](https://github.com/MaLaNg116/itervane/actions/runs/44978105151) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/44978105152)

B3d 接续安装配置、HTTP/MCP 与门户诊断详情，以及原生 Whiskers 和托管容器的端到端验收。P3-C 接续人工确认、处置和恢复验证。
