# P3-C2d2b2 · 指定版本恢复派发导读

依赖 #109，固定代码与测试为 `a9bf34214855ab4437f9b3fd402deb2da6144f8f`。 [实施计划](../plans/p3-c-operations-restore.md) · [PR #110](https://github.com/MaLaNg116/itervane/pull/110)

1. 恢复入口要求获批处置与本机登记的环境、目标摘要一致。配置请求的授权回调先用独立身份核对已停止的当前容器，随后在 PostgreSQL 保存发送授权。部署请求先回读目标配置，再单独复核批准与租约。 [安装范围与入口](https://github.com/MaLaNg116/itervane/blob/a9bf34214855ab4437f9b3fd402deb2da6144f8f/packages/control-plane/src/runtime/operations-execution-lease.ts#L250) · [派发顺序](https://github.com/MaLaNg116/itervane/blob/a9bf34214855ab4437f9b3fd402deb2da6144f8f/packages/control-plane/src/runtime/operations-restore-worker.ts#L27)
2. 迁移 0058 每个处置保留一笔配置发送记录和一笔部署发送记录。部署依赖同一执行代次经回读确认的配置。触发器核对已批准镜像、目标、写入者和新原生更新 ID，拒绝重复派发及历史发布的更新 ID。 [数据库约束](https://github.com/MaLaNg116/itervane/blob/a9bf34214855ab4437f9b3fd402deb2da6144f8f/packages/control-plane/migrations/0058_operations_restore_steps.sql#L19)
3. 派发后由更高代次领取核对。已知更新 ID、响应丢失和配置后撤销均保留各自的存储事实，环境占用保留，全局槽释放。接管读取原计划与步骤。 [交接与只读进度](https://github.com/MaLaNg116/itervane/blob/a9bf34214855ab4437f9b3fd402deb2da6144f8f/packages/control-plane/src/runtime/operations-execution-lease.ts#L322) · [故障用例](https://github.com/MaLaNg116/itervane/blob/a9bf34214855ab4437f9b3fd402deb2da6144f8f/packages/control-plane/test/integration/inspections.test.ts#L2900)

TypeScript、247 项单元、十项 PostgreSQL 17.12 专项及 Drizzle 一致性检查通过。真库场景使用可控的 Komodo 调用，验证配置后单次派发、旧回执、响应丢失和撤权。独立结算、运行版本登记和双版本参考环境联验进入 C2d3–C2d4。 [托管检查](https://github.com/MaLaNg116/itervane/pull/110/checks)
