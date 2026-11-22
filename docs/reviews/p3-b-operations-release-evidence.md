# P3-B3a · 运维诊断发布历史证据导读

接续 [运维调查循环 #75](https://github.com/MaLaNg116/itervane/pull/75)，源码与数据库用例固定于 `96587c836d004a034ae1c02fcdf98aa3f2878cbe`。 [分批计划](../plans/p3-b-formal-operations.md)

1. 证据查询先复用当前项目写权限、受保护环境、目标登记及发布占用核对。按已核验时间和发布操作排序，取得同一应用环境最近两条记录。当前与前一记录用同一校验核对候选、镜像、运行配置、实际派发和上线记录。前一记录与现行目标映射不符时，结果标记前一版本缺失。 [发布读取与校验](https://github.com/MaLaNg116/itervane/blob/96587c836d004a034ae1c02fcdf98aa3f2878cbe/packages/control-plane/src/service/operations-deployment.ts)
2. 领域入口对照冻结请求摘要、授权代次、发布及 Whiskers 登记。输出发布操作 ID、镜像摘要、核验时间和合成证据摘要。B3c 将在当前租约内调用此入口。 [证据投影](https://github.com/MaLaNg116/itervane/blob/96587c836d004a034ae1c02fcdf98aa3f2878cbe/packages/control-plane/src/service/operations-targets.ts)

本机 TypeScript、223 项单元和独立 PostgreSQL 17.12 的四项专项通过。历史用例通过正式领域协调器完成同一环境的三次结算，覆盖发布占用、旧请求、两份证明合成、换绑、跨项目、只读及授权代次变化。第二次发布可读到第一条核验记录。第三次更换现行映射后，前一版本标记缺失。专项使用受控下游回执，正式容器的诊断接续在 B3d。 [真库用例](https://github.com/MaLaNg116/itervane/blob/96587c836d004a034ae1c02fcdf98aa3f2878cbe/packages/control-plane/test/integration/inspections.test.ts)
