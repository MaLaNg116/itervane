# P3-A2-B2-A · 诊断任务的事务接收

接续 [Whiskers 后端登记 #68](https://github.com/MaLaNg116/itervane/pull/68)。迁移 `0e9bf8094df35ca4d9d72d447e8851c97b453bb1`，任务接收 `5109b0b018e8b5f775605d1c60d8ebbbe366acbb`。 [分批计划](../plans/p3-a-durable-observation.md)

1. 请求只携带项目、环境、语言和幂等键。领域服务从已核验发布取得仓库、提交和数据级别，固定同一操作的镜像、容器、目标登记、Whiskers 登记和授权代次。相同请求重放已有任务，调用方更换语言或任务类型时返回冲突。 [任务接收](https://github.com/MaLaNg116/itervane/blob/5109b0b018e8b5f775605d1c60d8ebbbe366acbb/packages/control-plane/src/service/tasks.ts#L85)
2. 一次数据库事务写入任务、`operations` run、绑定、工具预算、队列唤醒和接收事件。迁移补充外键和冻结触发器。持久化绑定只含发布与登记证据，队列只传任务及 run 标识。领取时依据当前项目权限核对原授权代次。 [迁移](https://github.com/MaLaNg116/itervane/blob/0e9bf8094df35ca4d9d72d447e8851c97b453bb1/packages/control-plane/migrations/0039_operations_requests.sql) · [队列领取核对](https://github.com/MaLaNg116/itervane/blob/5109b0b018e8b5f775605d1c60d8ebbbe366acbb/packages/control-plane/src/runtime/coordinator.ts#L15)
3. 集成测试用既有发布协调器形成正式证据，覆盖并发重放、跨类型冲突、已发队列记录随事务回滚、撤权后重授权和正常 Worker 对诊断角色的处理。双语任务名称及原因沿用现有词典。 [真实数据库用例](https://github.com/MaLaNg116/itervane/blob/5109b0b018e8b5f775605d1c60d8ebbbe366acbb/packages/control-plane/test/integration/inspections.test.ts#L2216)

本机 TypeScript 和 210 项单元检查通过。基线锁定镜像的 linux/amd64 层摘要及配置经核对后导入本机缓存，使用隔离的 PostgreSQL 17.12 测试数据库执行两项专项并通过。真实队列写入后注入错误，核对队列、任务及绑定均已回滚。托管回归待归档。本批交付内部接收，随 B2-B 接续受租约约束的原生读取与独立回执。
