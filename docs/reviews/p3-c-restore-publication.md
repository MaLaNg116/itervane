# P3-C2d3b · 指定版本恢复结算与当前实例导读

本批依赖 #111，固定代码及测试为 `a584c5ada314d5f328920b584e09fb910204668d`。 [实施计划](../plans/p3-c-operations-restore.md) · [PR #112](https://github.com/MaLaNg116/itervane/pull/112)

1. 核验成功后，同一事务保存回执、结算处置、释放环境和执行槽，并发布中英文成功事件。数据库在提交时核对回执、结算时间、任务状态、事件和调度一致。未知更新、目标变化和限次失败留在待人工状态，环境继续占用。 [结算事务](https://github.com/MaLaNg116/itervane/blob/a584c5ada314d5f328920b584e09fb910204668d/packages/control-plane/src/runtime/operations-restore-recovery.ts#L89) · [提交期约束](https://github.com/MaLaNg116/itervane/blob/a584c5ada314d5f328920b584e09fb910204668d/packages/control-plane/migrations/0061_operations_current_publication.sql#L506)
2. 当前实例从已验证正式发布和已结算恢复的派发记录中选择，顺序取同一个全局执行槽的派发代次。运行证据绑定原正式发布、独立恢复回执和新容器。历史档案保留原发布事实，下一次恢复可选择同登记下已验证的不同镜像。 [版本查询](https://github.com/MaLaNg116/itervane/blob/a584c5ada314d5f328920b584e09fb910204668d/packages/control-plane/migrations/0061_operations_current_publication.sql#L2) · [回执读取与核对](https://github.com/MaLaNg116/itervane/blob/a584c5ada314d5f328920b584e09fb910204668d/packages/control-plane/src/service/operations-deployment.ts#L60)
3. 新实例的诊断绑定加上恢复执行 ID。诊断、提案、人工批准、预约、派发意图和重启核验校验同一当前实例。已有正式发布请求的原指纹仍可读取。真实 PostgreSQL 首轮发现重启回执的 SQL 列名与局部变量重名，修正后复跑原生重启调用路径对应的数据库用例和恢复后重启。 [绑定校验](https://github.com/MaLaNg116/itervane/blob/a584c5ada314d5f328920b584e09fb910204668d/packages/control-plane/migrations/0061_operations_current_publication.sql#L32) · [重启核验约束](https://github.com/MaLaNg116/itervane/blob/a584c5ada314d5f328920b584e09fb910204668d/packages/control-plane/migrations/0061_operations_current_publication.sql#L418)
4. 真库验证已核验回执不能单独提交，结算缺回执也会回滚。A → B → 恢复 A 后重新诊断并完成已批准重启，旧 A 的批准在服务层和数据库均被阻断。正式发布 C 接管后续诊断的当前版本。 [结算与故障用例](https://github.com/MaLaNg116/itervane/blob/a584c5ada314d5f328920b584e09fb910204668d/packages/control-plane/test/integration/inspections.test.ts#L2986) · [跨版本回归](https://github.com/MaLaNg116/itervane/blob/a584c5ada314d5f328920b584e09fb910204668d/packages/control-plane/test/integration/inspections.test.ts#L3073)

TypeScript、247 项单元、22 项 PostgreSQL 17.12 专项及 Drizzle 一致性检查通过。真库专项使用可控的 Komodo 回执和入口状态。参考环境的实际双版本恢复以及门户与 MCP 入口验收归 C2d4，恢复入口在该联验通过后启用。 [托管检查](https://github.com/MaLaNg116/itervane/pull/112/checks)

固定代码的[九项托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45029329925)全部通过，涵盖现有隔离 Runner、受保护发布和原生重启回归。
