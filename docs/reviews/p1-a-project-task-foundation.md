# P1-A Review guide：身份、资源与持久化任务

- 批次：002，[PR #2](https://github.com/MaLaNg116/itervane/pull/2)，关联记录见 [交付索引](README.md)。
- 前置：PR #1；比较基线 `3063bfc`，不需要重复 review P0 的全部代码。
- 本批核心代码快照：`4390942ba098651cd18c62777c5edf4930ae8884`；后续运行说明与授权 SQL 单独提交。
- 日期：2026-11-18。
- [开发计划](../plans/p1-a-project-task-foundation.md)、[运行说明](../control-plane-p1-a.md)、[开发/运行闸门 ADR](../decisions/0001-development-and-runtime-gates.md)。

## 1. 本批解决什么问题

把 P0 分开的协议/数据库实验推进为一个正式控制面切片：验证访问令牌 → 查询当前主体权限 → 登记项目资源 → 接收固定版本任务 → 同事务保存 task/run/event/唤醒 → 查询或取消。

这是 P1 的部分模块，不是完整 P1 或 MVP。没有 Worker 消费队列；没有执行项目代码、真实扫描、发布或运维动作。运行能力不会因为接口存在或测试通过而自动开启。

本批新增 `@itervane/control-plane`，没有把 P0 verification 当生产领域层复用。仍保持模块化单体，HTTP、领域服务和持久化目录在同一包中按责任分开。

锁文件与 Drizzle snapshot 占据大部分机械生成内容。建议逐行 review migration SQL、schema、auth、service、api 和关键测试；snapshot 用于检查生成一致性，不需要逐行当手写逻辑阅读。

## 2. 阅读地图

| 顺序 | 文件 | 主要问题 |
|---|---|---|
| 1 | contracts/control-plane.ts、primitives.ts | API 能接受什么输入，输出和能力声明是否受约束 |
| 2 | persistence/schema.ts、0000 SQL | 跨项目关系、唯一约束与正式迁移 |
| 3 | auth/identity.ts | token 验签、可信 issuer、ID token 混用与身份上下文 |
| 4 | service/access.ts、resources.ts | 当前授权、维护者 bootstrap 和资源登记 |
| 5 | service/tasks.ts | 幂等、原子入队、事件和版本化取消 |
| 6 | api.ts、config.ts、entries | 协议边界、错误脱敏、启动和退出 |
| 7 | test/integration/control-plane.test.ts | 对上述结论的真实 PG/JWKS/路由断言 |

## 3. 公开契约：客户端不能决定身份或执行资格

读 [control-plane.ts](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/contracts/src/control-plane.ts)。

资源输入使用严格 Zod 对象，拒绝 actor、批准、权限和 access=public 等额外字段。仓库只收 HTTPS URL，拒绝 userinfo/query/fragment；名称规范化后用于持久化。

Task DTO 不暴露 request_hash、内部幂等 key 或 wakeup job 的私有结构。事件只公开受控字段；环境输出必须为 protected。capabilities 的执行、MCP、sandbox、deployment、operations 都是 literal false，不接受客户端或环境变量直接打开。

primitives.ts 保存共享 enum 元组，Zod 和 Drizzle 共用，避免状态列表漂移，也避免 index.ts 与新契约之间出现循环初始化。

检查点：严格输入仅是形状检查；项目归属和实际权限必须继续看领域服务及数据库约束。

## 4. 正式数据模型与迁移

读 [schema.ts](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/src/persistence/schema.ts) 和 [初始 SQL](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/migrations/0000_initial_control_plane.sql)。

```text
principal(issuer + sub)
  → workspace owner / project membership
  → project → repository / application → environment
  → task → task_run / task_event
```

数据库只允许一个 singleton workspace 和一个 owner。项目权限模型保留 maintainer/viewer；本批没有成员管理 API，不宣称多租户产品已实现。

任务和仓库通过 `(repository_id, project_id)` 复合外键关联，环境和应用也使用复合外键，避免仅凭正确 UUID 混入其他项目资源。任务幂等唯一键是项目、可信 principal 和 request key；run 代次及事件 sequence 另有唯一/正数约束。

正式 schema 为 itervane，pg-boss 为 itervane_queue。迁移 SQL 由 Drizzle Kit 生成后审查；migrate.ts 使用独立连接和 advisory lock，核对已应用 SQL 哈希，再执行 Drizzle 和队列各自的迁移。SQL 不可原地修改；新增变更生成新版本。

读 [database.ts](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/src/persistence/database.ts)。运行进程关闭 migrate/createSchema/supervise/schedule，没有 Worker；启动检查并拒绝 superuser、建库/建角色/数据库或相关 schema CREATE 权限。领域池最多 4、队列池最多 2，领域查询/空闲事务有超时。

基础设施 error 事件只输出 component/code，不打印驱动异常；关闭函数复用同一个 Promise，避免多次关闭连接池。

## 5. 身份认证与领域授权是两个步骤

读 [identity.ts](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/src/auth/identity.ts)。

固定维护者配置的 issuer/audience，使用 jose 和 realm 的 JWKS 验证 RS256、exp/iat/sub、JWT header type 以及 Keycloak 的 Bearer payload type。拒绝 ID/refresh token、错误 issuer/audience、未来 iat、错误签名和无签名 token；不信任 token 自带 jku。JWKS 禁止重定向，有缓存与超时；故障返回 unavailable，不降级匿名。

验证结果带模块私有 Symbol 标记并冻结，只向领域服务交付 issuer/sub。这个标记阻止把普通 JSON 误当已验证身份，不是公开客户端凭证。

然后读 [access.ts](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/src/service/access.ts)。requireActor 根据 issuer/sub 查登记 principal；requireProject 查当前 workspace owner 或 project_members。token 中的 admin/realm_access 不直接成为平台权限。

身份/成员记录在短事务中共享锁定，使删除权限与当前命令有确定先后顺序。未知主体 403，未授权项目/任务 404；viewer 可读取本项目，写入需要 maintainer。

当前 principal 不承担人类批准模型；本批没有批准接口。后续引入审批时还要明确人类/服务主体类别与不可自批规则，不能把一个能登录的主体自动当成人类批准者。

## 6. 维护者与资源登记

读 [resources.ts](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/src/service/resources.ts#L20)。

bootstrapOwner 仅由本机可信维护命令调用。事务 advisory lock 串行化首次初始化，同 issuer/sub 重复执行返回原 owner，其他主体不能替换所有权。HTTP 不提供 bootstrap，也不会自动登记首个 token 持有者。

项目创建需要 workspace owner；仓库、应用、环境写入都重新检查项目权限。环境先检查 application 属于当前项目，数据库复合外键再作兜底。登记只保存元数据，不拉取仓库、不部署应用、不配置反向代理。

## 7. 接收任务：完整请求指纹与原子入队

读 [tasks.ts 第 27 行](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/src/service/tasks.ts#L27)。

```text
严格解析输入 → 固定顺序计算完整请求指纹
  → 查询当前身份和项目写权限 → 确认仓库归属
  → INSERT task（唯一键处理重复）
  → INSERT run → pg-boss send（同一 Drizzle transaction）
  → 保存 job ID → INSERT accepted event → COMMIT
```

与 P0 只比较 snapshot 不同，本批指纹覆盖 project/source/key/purpose/dataClass；JSON 字段顺序不会改变指纹。同 key 同内容返回原 task；改 purpose/dataClass 等也会冲突。task/run/generation 都由服务端生成。

queue.send 使用 fromDrizzle(tx, sql)，消息通过 wakeupSchema 校验，只包含 taskId/runId/generation。任何后续写入失败，领域记录和真实队列消息一起回滚。

返回 202 只表示已接受、已排队，不能理解为开始执行或审计成功。重复请求返回 200，即使原任务已取消，也不会自动创建或恢复另一个任务。

## 8. 查询、事件与排队取消

Task 查询、列表、事件、取消均使用同一当前项目授权。列表有条数上限，任务与当前 generation 的 run 用一次 JOIN 获取；没有 N+1 查询。

读 [tasks.ts 第 88 行](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/src/service/tasks.ts#L88)。取消先授权，再锁 task，检查状态和 expectedVersion，条件更新为 cancelled，同时取消同事务中的唤醒、更新 run、追加事件。

重复取消不产生第二条事件。旧 expectedVersion 被拒绝；只有 queued 可以立即取消，其他执行状态返回 unsupported_state，不伪装成已停止远端动作。

## 9. HTTP、配置与启动

读 [api.ts](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/src/api.ts#L45)。

除最小 liveness 外，所有路由都验证 bearer。资源与任务调用领域服务，因此后续 MCP 可以复用相同授权/事务能力。入站 parseInput 失败为 invalid_input；出站 DTO 校验失败为 internal_error，不能把服务端数据损坏归咎调用者。

请求体 64 KiB，查询 limit 默认 50/上限 100；不接受任意 query 字段。requestId 由服务端生成，日志只用路由模板而非原始 URL。错误响应只含 code/requestId；无原始 SQL、参数、token 或 SDK 堆栈。

config.ts 要求显式身份和数据库配置，默认 localhost:4310。迁移账号不回退到运行账号，API 不自动迁移。三个命令分别是 db:migrate、bootstrap:owner、start:api；具体低权限授权 SQL 和配置见运行说明。

## 10. 本批真实验证与边界

2026-11-18 本地检查结果：43 项单元测试、26 项真实 PG 集成测试，其中本批 15 项；可信标准应用构建/5 项测试、MCP 三项协议检查通过，Drizzle 再生成确认没有 schema 变化。

检查 [integration/control-plane.test.ts](https://github.com/MaLaNg116/itervane/blob/4390942ba098651cd18c62777c5edf4930ae8884/packages/control-plane/test/integration/control-plane.test.ts)。主要证据包括：

| 路径 | 实际断言 |
|---|---|
| 未认证与初始化 | liveness 最小化、401、未知主体 403、并发显式 bootstrap 幂等、拒绝替换 owner |
| 跨项目关系 | 环境关联错误项目拒绝，直接 SQL 也被复合外键拒绝；跨项目任务/事件/cancel 均拒绝 |
| 当前权限 | token admin 声明无效；viewer 只读；删除权限后同一个 token 无法继续访问 |
| 原子接收 | 并发请求一份 task/run/event/job；完整内容变更冲突；后续事件写入失败回滚实际 queue insertion |
| 原子取消 | 版本冲突、并发重复取消只有一条事件；取消事件失败时 queue/task/run 一起回滚 |
| 持久化 | 新 API 实例与新数据库连接读到相同任务；不是进程内 Map |
| 运行角色 | 实际低权限账号运行；CREATE TABLE 被拒；高权限账号启动被拒 |
| 迁移 | 重复迁移安全；篡改已应用哈希后拒绝迁移 |
| 错误与日志 | 无效服务端输出为 500；credential/body/query/request-id 标记不进入日志；基础设施错误仅分类 |
| HTTP | 真实 localhost TCP 请求验证 200/401/已登记身份，其他组合走 Fastify 路由注入 |

测试在临时 PG17 实例中新建随机数据库和随机运行角色；只清理本次标记数据库，不截断调用者提供的原始测试库。密码随机产生，不输出或提交。没有真实 Keycloak realm、浏览器登录或公网 SSO 验收。

仍待后续：Worker/执行权、LangGraph 与正式任务串联、真实源码/扫描、VM Runner、外部 MCP、门户、候选/人工批准、Komodo/Whiskers 和三条端到端闭环。环境 protected 目前只是登记约束，不代表真实网关已配置。

## 11. 对照提交阅读

按计划 → 契约 → 数据模型 → 认证 → 资源 → 任务 → API → 运行权限修正 → 测试 → 配套检查的顺序阅读。首要检查 auth/access 的信任来源、task admission/cancel 的事务边界、跨项目复合外键及 runtime 账号权限，最后核对运行说明中的未覆盖事项。
