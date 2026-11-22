# P3-C2c3c2b1 · 重启等待过期核对导读

依赖 #101，固定代码和测试为 `a52365fc6498fb86861e5cf48b0b42b238146c7e`。 [PR #102](https://github.com/MaLaNg116/itervane/pull/102) · [分批计划](../plans/p3-c-restart-operator.md)

1. `b104404` 在专用 Worker 的协调周期检查本环境的过期等待。加锁后核对同一执行项、登记、状态和数据库时间，沿用已登记的原生批准，追加过期事件并原子入队一次只读核对。任务回执展示最后一个事件的双语原因。 [协调与锁](https://github.com/MaLaNg116/itervane/blob/a52365fc6498fb86861e5cf48b0b42b238146c7e/packages/control-plane/src/runtime/operations-execution-lease.ts#L482) · [事件与唤醒](https://github.com/MaLaNg116/itervane/blob/a52365fc6498fb86861e5cf48b0b42b238146c7e/packages/control-plane/src/runtime/operations-restart-request.ts) · [回执投影](https://github.com/MaLaNg116/itervane/blob/a52365fc6498fb86861e5cf48b0b42b238146c7e/packages/control-plane/src/service/operations-restart-view.ts)
2. `a52365f` 用真实 PostgreSQL 验证批准到期前后、其他登记、两个 Worker 竞争和后继执行权。流程保留原生编号，核对期间没有续发记录。恢复证据已出现但原生许可未结清时，状态为待人工核对，发布互斥依然生效。 [真库用例](https://github.com/MaLaNg116/itervane/blob/a52365fc6498fb86861e5cf48b0b42b238146c7e/packages/control-plane/test/integration/inspections.test.ts#L3353)

TypeScript、246 项单元与三项 PostgreSQL 17.12 专项通过，覆盖批准过期、门户排队与续发以及排队后的人工撤销。该批真库使用限定的下游响应。浏览器交互和同一标准应用真实审批至恢复由后续批次验收。 [托管检查](https://github.com/MaLaNg116/itervane/pull/102/checks)
