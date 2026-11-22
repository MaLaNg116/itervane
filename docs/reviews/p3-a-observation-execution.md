# P3-A2-B2-B · 受租约约束的只读观察

接续 [诊断任务接收 #69](https://github.com/MaLaNg116/itervane/pull/69)。运行实现 `6ba542f50128850c7ba6e42bc13a008beae0ace0`，迁移 `bb80d343fedde26cad7eade4b424249d1ceec16a`。 [分批计划](../plans/p3-a-observation-execution.md)

1. 安装维护者使用 `ITERVANE_OPERATIONS_ENVIRONMENT_ID`、`ITERVANE_OPERATIONS_ENROLLMENT_SHA256` 和独立的 `ITERVANE_OPERATIONS_WHISKERS_READ_KEY` 配置 Worker。不同环境或缺少安装的 Worker 推迟唤醒。原授权代次失效时转人工。匹配安装按现有全局执行槽取得租约。 [安装示例](https://github.com/MaLaNg116/itervane/blob/6ba542f50128850c7ba6e42bc13a008beae0ace0/.env.example) · [领取逻辑](https://github.com/MaLaNg116/itervane/blob/6ba542f50128850c7ba6e42bc13a008beae0ace0/packages/control-plane/src/runtime/coordinator.ts)
2. 读取前预留一次持久化预算。Whiskers 调用阶段逐次复核授权、租约、发布占用和当前目标。事务只负责校验和写入，网络读取在事务外执行。两个执行者在不同代次可以读取，结果以最终仍持有效租约的执行者为准。 [运行实现](https://github.com/MaLaNg116/itervane/blob/6ba542f50128850c7ba6e42bc13a008beae0ace0/packages/control-plane/src/runtime/operations-execution.ts)
3. 回执核对绑定容器、Whiskers 服务器、发布操作及执行代次。回执、完成事件和运行结果在同一事务写入。数据库约束校验租约和完成事件，并冻结已完成的观察。中文和英文共享同一事件。 [数据库触发器](https://github.com/MaLaNg116/itervane/blob/bb80d343fedde26cad7eade4b424249d1ceec16a/packages/control-plane/migrations/0040_operations_observations.sql) · [真实数据库用例](https://github.com/MaLaNg116/itervane/blob/6ba542f50128850c7ba6e42bc13a008beae0ace0/packages/control-plane/test/integration/inspections.test.ts)

本机 TypeScript、210 项单元检查、PostgreSQL 17.12 的八项专项通过。受控回执覆盖匹配安装、原子保存、中英文事件、取消及换绑后丢弃、后继 Worker 接手和预算耗尽。B2-C 将同一 Worker 接到真实 Whiskers 与本轮 Komodo 已发布容器。托管回归待归档。

托管常规 CI 与原生 Whiskers 回归通过。KVM 场景在同一非文档版本运行。 [托管真实数据库与浏览器](https://github.com/MaLaNg116/itervane/actions/runs/44967527210) · [原生 Whiskers](https://github.com/MaLaNg116/itervane/actions/runs/44967521367) · [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44967521413)
