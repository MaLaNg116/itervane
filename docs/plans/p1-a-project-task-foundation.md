# P1-A：身份、资源登记与持久化任务开发计划

- 日期：2026-11-18。
- 产品基线：[蓝图 v6](../blueprint-v6.md)。
- 分阶段基线：[实施计划 v2](../implementation-plan-v2-ts-postgresql.md)、[开发计划 v1](../development-plan-v1.md)。
- 前置交付：[PR #1 / P0 导读](../reviews/pr-001-p0-foundation.md)。
- 顺序调整：[ADR 0001](../decisions/0001-development-and-runtime-gates.md)。

## 本批目标

交付一个默认仅监听 localhost、没有执行能力的控制面 API：可信身份 → 已登记维护者 → 项目/仓库/应用/环境 → 固定快照任务 → 原子入队 → 持久化查询或排队取消。

本批属于 M01、M02、M07、M13 和最小 API 的局部落地，完整 P0/P1 均不因此验收通过。外部 MCP、门户、有效执行权/Worker、领域 Agent、Runner、真实扫描、发布和运维留在后续批次。

## 技术与模块

| 模块 | 选择与职责 |
|---|---|
| 公开契约 | 扩充 `@itervane/contracts`，入站/出站 Zod 校验，拒绝调用者自带 actor/批准/执行状态 |
| 正式控制面 | 新增 `@itervane/control-plane`，按 auth、persistence、service、api 分目录，保持模块化单体 |
| HTTP | Fastify 5.12.8；不自行实现 Web 框架；请求体、URL、日志和错误均受约束 |
| 身份 | jose 6.2.17 验签；首期 Keycloak 风格 RS256 access token；固定 issuer/audience、JWKS、exp/iat/sub/type |
| 授权 | 主体通过 issuer+sub 映射到已登记 principal，权限查 PostgreSQL；忽略 token 自带平台角色 |
| 数据 | PostgreSQL 17、Drizzle 0.45.4、node-postgres 8.23.1；正式固定 schema `itervane` |
| 迁移 | Drizzle Kit 0.31.11 生成版本化 SQL，审查后用独立迁移命令执行 |
| 调度 | pg-boss 12.38.2、独立 `itervane_queue` schema；本批只接收/取消唤醒，禁用 Worker |

运行进程不执行迁移；迁移使用独立配置。生产启动不支持 mock auth、静态万能 token、匿名项目接口或默认管理员；bootstrap 必须由本机维护命令明确绑定 issuer 和 sub。

## 任务与依赖

| 任务/提交 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| A1 契约 | 资源创建、DTO、任务查询/取消与结构化错误 | P0 契约 | 严格入站/出站；固定版本；拒绝越权字段及含凭证仓库 URL |
| A2 数据模型与迁移 | principal、单工作区、成员、项目、仓库、应用、环境、task/run/event；唯一和跨项目关联约束 | A1 | 干净 PG17 可迁移，重复迁移安全；已有 migration 被篡改时拒绝 |
| A3 认证 | 固定 Keycloak issuer/JWKS；签名、算法、aud、时效、token 类型；服务端身份 | A1 | 实际本地 JWKS+签名 token；过期/错误签名/ID token/错误 aud 被拒；不跟随重定向 |
| A4 领域服务 | 明确维护者 bootstrap、当前授权、资源登记、幂等任务接收、事件、排队取消 | A2 | 领域任务/run/event/队列同事务；跨项目资源拒绝；重试一个任务；取消 CAS 与队列同事务 |
| A5 API/运行入口 | 认证 API、最小查询、任务列表、能力状态；配置、启动和关闭 | A3、A4 | API 重建后状态保留；错误脱敏；未知用户拒绝；无执行/部署工具入口 |
| A6 验证与交付 | 真实 PG17 与 HTTP/JWKS 测试、CI、运维说明、review guide | A1—A5 | 独立提交、独立 PR；导读对应固定代码快照；未覆盖真实组件明确标记 |

## 数据库和并发决定

领域记录与队列保持同库分 schema。正式表不复用 P0 随机 schema，也不读取 pg-boss 私有表作为领域事实。

任务幂等范围为项目、可信 principal 和请求 key；指纹覆盖完整规范化任务输入。同 key 同内容返回原任务，不同内容返回冲突。服务端创建 task/run/generation，客户端不决定执行权。仓库必须属于当前已授权项目，数据库复合外键继续约束跨项目关系。

取消只立即处理 queued 任务，按 expectedVersion 条件更新，同时取消对应唤醒并追加有序领域事件。已取消的重复请求返回原结果；本批不伪造正在执行任务的取消与远端撤销。排队不会启动 Agent。

领域池与队列池分别设上限；禁止模型/人工等待长事务。迁移按固定 advisory lock 串行。运行账号无常驻 DDL，测试验证该限制。

## HTTP 范围

`/health/live` 只返回最小存活状态；`/v1/me`、`/v1/capabilities`、项目/仓库/应用/环境登记和查询、任务接收/查询/事件/取消均需认证及领域授权。列表限制条数，不回传数据库实体的内部字段。

身份由 access token 验证结果建立。请求 body/query 不接受 actor、权限、批准、密钥、任意 SQL/命令或执行开关。未授权项目及任务返回统一 not_found，避免通过 ID 探测其他项目。无 CORS 通配授权，无 Cookie 会话或浏览器登录流程。

## 必须保持待验

真实 Keycloak realm/audience 配置及浏览器登录、外部编码助手 MCP、Worker/LangGraph 持久化循环、虚拟机生命周期/网络边界、真实扫描、Komodo 发布、Whiskers 原生批准、运行入口保护和三条端到端闭环。

本地测试只运行维护者编写的测试代码、签名身份夹具与隔离 PG17。暂时没有 KVM，不在控制面或普通容器运行提交的仓库。

## 资料依据

使用官方文档核对接口：[Fastify](https://fastify.dev/docs/latest/Reference/Server/)、[jose jwtVerify](https://github.com/panva/jose/blob/main/docs/jwt/verify/functions/jwtVerify.md)、[Drizzle migrations](https://orm.drizzle.team/docs/migrations)、[Keycloak JWKS](https://www.keycloak.org/securing-apps/oidc-layers)、[Keycloak token 类型](https://github.com/keycloak/keycloak/blob/main/core/src/main/java/org/keycloak/util/TokenUtil.java)。具体兼容性由本批实际测试确认，版本升级另行验证。
