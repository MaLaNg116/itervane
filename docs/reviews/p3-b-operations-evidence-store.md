# P3-B3b · 正式诊断冻结与证据预留导读

接续 [发布历史证据 #76](https://github.com/MaLaNg116/itervane/pull/76)。迁移固定于 `20bf099f698244e2bb0b277197962a5512141bc0`，任务接收固定于 `ad3ae485b84a032bb3dfd08eb796e38d082d08db`，证据存储与测试固定于 `f597668c2f3455bdcd6a83b823cecd94ce95d990`。 [分批计划](../plans/p3-b-operations-evidence-store.md)

1. 同一事务保存任务、发布范围、冻结模型指纹、输入摘要、读取预算与队列。重放复用原记录。诊断运行要求 Worker 的环境、登记和模型指纹匹配。遗留观察有自己的预算和结算路径。数据库按冻结模式校验记录。 [任务接收](https://github.com/MaLaNg116/itervane/blob/ad3ae485b84a032bb3dfd08eb796e38d082d08db/packages/control-plane/src/service/tasks.ts) · [领取条件](https://github.com/MaLaNg116/itervane/blob/ad3ae485b84a032bb3dfd08eb796e38d082d08db/packages/control-plane/src/runtime/coordinator.ts)
2. 一次类别预算对应一条运行与操作 ID 的唯一预留。首次预留、后继接管和正式记录分别校验租约、授权、绑定及预算。接管复用原操作 ID，最多追加一次读取尝试。完成后从数据库重放原事实与证明摘要。 [证据存储](https://github.com/MaLaNg116/itervane/blob/f597668c2f3455bdcd6a83b823cecd94ce95d990/packages/control-plane/src/runtime/operations-evidence-store.ts) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/20bf099f698244e2bb0b277197962a5512141bc0/packages/control-plane/migrations/0041_operations_diagnosis.sql)

本机 TypeScript、223 项单元及独立 PostgreSQL 17.12 的六项专项通过。真库覆盖提交和队列原子回滚、并发提交、模型和登记匹配、重复预留、旧围栏、记录重放、接管预算、取消、换绑及已有观察路径。生成的 Drizzle 快照随迁移保存。B3c 接续 Worker、受护图检查点和最终结算。 [真库验收](https://github.com/MaLaNg116/itervane/blob/f597668c2f3455bdcd6a83b823cecd94ce95d990/packages/control-plane/test/integration/inspections.test.ts)
