# P4-B1 · 正式修复与重启案例

接续 [PR #136](https://github.com/MaLaNg116/itervane/pull/136)。案例服务固定于 `afbdbccfa7591765351ddac1d196659e4a5a8c05`，迁移固定于 `fd07a3f981351e62b05c819d4e61ebf0c72dc169`。 [实施计划](../plans/p4-verified-learning-cases.md)

1. `POST /v1/tasks/:taskId/learning-case` 要求项目写权限、任务当前运行编号和已公开的结果摘要。代码案例读取正式独立复验，确认已解决的源码发现或已修复的健康续测，保存前后快照及补丁摘要。运维案例验证诊断、明确批准、原生应答、同实例独立恢复和项目关联。 [来源核对](https://github.com/MaLaNg116/itervane/blob/afbdbccfa7591765351ddac1d196659e4a5a8c05/packages/control-plane/src/service/learning-case-evidence.ts#L18)
2. 每个源运行保存一份不可变记录，重复请求返回同一案例。数据库再次核对项目授权、版本和证据。按项目及类别分页，读权随项目角色变化，双语标题在读取时投影。案例正文包含结构化结果及摘要，运维日志和项目源码留在原证据边界内。 [写入与读取](https://github.com/MaLaNg116/itervane/blob/afbdbccfa7591765351ddac1d196659e4a5a8c05/packages/control-plane/src/service/learning-cases.ts#L37) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/fd07a3f981351e62b05c819d4e61ebf0c72dc169/packages/control-plane/migrations/0073_verified_learning_cases.sql#L28)
3. 在原生健康修复和受控重启场景，新增正式 HTTP 采集、双语重放和回查，同一工件关联源运行和独立证据。提炼角色、候选验证及正式复用由 P4 后续批次接续。 [原生采集](https://github.com/MaLaNg116/itervane/blob/d964958baab580af0307641e32d9ed52e5ba9667/packages/control-plane/test/native/worker-inspection.ts#L379)

TypeScript、Drizzle、工作流 Bash 和 PostgreSQL 17.12 的 5 项专项通过。真库覆盖同证据并发、旧运行、错误摘要、持续异常、恢复未结算、项目撤权和不可变记录。用例使用签名 OIDC 与确定性模型，Runner 和运维回执由可信夹具提供；托管场景再核对真实下游。首轮发现 JSONB 删除字段表达式存在运算歧义，补足分组和类型后从空库复跑。 [数据库用例](https://github.com/MaLaNg116/itervane/blob/1210f80af49dfdafdd6e243e3db2066f9597a15e/packages/control-plane/test/integration/inspections.test.ts#L3665) · [托管检查](https://github.com/MaLaNg116/itervane/pull/137/checks)
