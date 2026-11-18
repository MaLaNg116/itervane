# P1-A 控制面：运行和验证

- 日期：2026-11-18。
- 本批计划：[P1-A](plans/p1-a-project-task-foundation.md)。
- Review 入口：[分批索引](reviews/README.md)。

本文记录 P1-A 的交付状态；后续 Worker、外部 MCP、多语言和新增迁移见 [P1-B 说明](control-plane-p1-b.md)。下文“没有 Worker”等描述对应本批固定历史版本。

## 当前能力

控制面提供 Keycloak 风格 RS256 access token 验证、已登记主体的当前项目权限、单工作区维护者初始化、项目/HTTPS 仓库/应用/环境登记，以及固定 Git 快照任务的接收、查询、事件与排队取消。

Task、run、事件和 pg-boss 唤醒在同一 PostgreSQL 事务内提交；重复请求返回原任务，改变请求内容产生冲突。取消 queued 任务使用版本条件更新，同时取消唤醒并记录事件。运行账户不能拥有 DDL 权限，启动会检查并拒绝高权限账号。

**没有 Worker 消费队列。任务保持 queued，直到维护者取消或后续批次实现正式执行。** `/v1/capabilities` 中 taskExecution、externalMcp、sandbox、deployment、operations 均固定为 false。

环境记录中的 protected 是当前支持范围声明，不代表已经配置 Traefik 或部署了受保护应用。本批没有拉取仓库、安装依赖、执行项目命令、真实扫描或基础设施变更。

## 配置和首次启动

前置为 Node.js 24、pnpm 11.9.0、PostgreSQL 17，以及维护者配置的 Keycloak realm。Keycloak 实例、浏览器登录与真实 realm 集成本轮未部署验证；本地自动测试使用独立 JWKS 签名夹具。

先安装锁定依赖。复制或合并 `.env.example` 到忽略提交的本机 `.env`，不要覆盖已有密钥：

```sh
pnpm install --frozen-lockfile --ignore-scripts
```

| 配置 | 内容 |
|---|---|
| `ITERVANE_MIGRATION_DATABASE_URL` | 独立迁移账号，拥有该专用平台数据库的建表/迁移权限 |
| `DATABASE_URL` | 同一个数据库的运行账号，限 schema USAGE、表 DML 和序列使用，无 DDL |
| `ITERVANE_OIDC_ISSUER` | realm 的精确 issuer，HTTPS；HTTP 只允许 loopback 开发 |
| `ITERVANE_OIDC_AUDIENCE` | API 受众，默认示例为 itervane-api，需在身份服务配置对应 audience |
| `ITERVANE_OWNER_SUBJECT` | 明确选定维护者的 OIDC sub，只有 bootstrap 命令使用 |
| `ITERVANE_API_HOST` / `ITERVANE_API_PORT` | 默认 127.0.0.1:4310 |

两个数据库 URL 不要使用同一高权限账号。迁移命令不会回退到 DATABASE_URL，API 启动不会自动执行迁移。

```sh
pnpm db:migrate
```

迁移采用 Drizzle Kit 生成并审查的 SQL，运行时使用 Drizzle migrator；advisory lock 将同一平台的迁移串行化，并检查已应用 SQL 的哈希。历史 SQL 不可原地改写；新增变更生成新 migration。队列迁移由 pg-boss 独立管理。

初次安装需要数据库管理员创建低权限运行角色。例如在 psql 中：

```sql
CREATE ROLE itervane_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
\password itervane_app
```

然后在 itervane 数据库执行 `packages/control-plane/ops/runtime-grants.sql`，将运行角色对应的 URL 配置到 DATABASE_URL。数据库名或角色名不同，先调整该受审查的 SQL。新增表的后续迁移完成后重新核对/授予运行权限，不向运行账号授予 schema CREATE。

在身份服务明确 API audience、RS256 和维护者 sub 后，执行：

```sh
pnpm bootstrap:owner
pnpm start:api
```

bootstrap 幂等，只接受与已有 owner 一致的 issuer/sub，不能自动替换所有者。HTTP 没有 bootstrap、匿名注册或“首个登录者成为管理员”的入口。

默认仅监听 localhost。覆盖监听地址前需要自行配置受保护的 TLS 入口；本批没有公网部署验收。

## 身份验证与权限边界

API 只使用 Authorization: Bearer access token，不使用 query token、Cookie 会话、客户端 actor 或代理身份头。JWT 需要 RS256 签名、固定 issuer/audience、sub、iat、exp、JWT header type，以及 Keycloak 的 Bearer payload type。最多接受一小时 token age，并有五秒时钟容差；ID 和 refresh token 被拒绝。

JWKS 只从维护者配置的 issuer 下 `/protocol/openid-connect/certs` 获取，禁止重定向，三秒超时、五分钟缓存。不会采用 token 自带的 jku/issuer 地址取公钥。JWKS 不可用返回 503，验证失败返回 401；没有匿名降级。

角色和项目权限来自当前数据库记录，token 中的 realm_access/admin 声明不直接成为平台权限。未知主体返回 403，不创建 principal。首次 owner 由本机可信命令登记。project_members 的后续用户/权限管理界面尚未提供，本批只做查询授权与维护者路径。

每次命令在短事务中锁定所依据的身份/成员记录，撤销与命令有确定先后顺序。未授权项目、任务及事件统一返回 not_found，不能通过 ID 查询其他项目数据。

## 接口范围

| 方法 | 路径 | 行为 |
|---|---|---|
| GET | `/health/live` | 最小匿名存活状态，不显示数据库/身份配置 |
| GET | `/v1/me`、`/v1/capabilities` | 当前已登记主体及本批支持能力 |
| GET / POST | `/v1/projects` | 限权列表 / owner 创建项目 |
| GET / POST | `/v1/projects/:projectId/repositories` | 当前项目仓库登记与列表；不拉取源码 |
| GET / POST | `/v1/projects/:projectId/applications` | 应用登记与列表 |
| GET / POST | `/v1/projects/:projectId/environments` | 环境登记与列表；应用必须属于同项目 |
| POST | `/v1/tasks` | 接收已登记仓库的固定快照任务，首次 202，重复 200 |
| GET | `/v1/projects/:projectId/tasks` | 当前项目任务列表 |
| GET | `/v1/tasks/:taskId`、`/v1/tasks/:taskId/events` | 任务及有序领域事件 |
| POST | `/v1/tasks/:taskId/cancel` | `{ "expectedVersion": 1 }`，只立即取消 queued 任务 |

GET 列表支持 `limit`，默认 50、上限 100；本批没有 cursor 分页或可靠总数。查询不接受任意过滤字段。

接收任务的 JSON 示例（ID 应替换为已登记资源）：

```json
{
  "projectId": "<registered-project-id>",
  "source": { "repositoryId": "<registered-repository-id>", "commit": "<full-40-or-64-character-git-id>" },
  "purpose": "Audit the fixed synthetic-data example",
  "dataClass": "synthetic",
  "idempotencyKey": "caller-generated-request-key"
}
```

仓库 URL 仅接受 HTTPS，拒绝 userinfo、query 和 fragment，凭证不随登记请求保存。任务输入拒绝 approved、actor、执行状态、密钥等额外字段；完整规范化输入参与幂等指纹。

API 入站和出站分别校验。无效输入为 400；版本/幂等冲突为 409；服务器返回值不符合契约为 500。错误只包含 code 和服务端生成的 requestId，日志只记录请求 ID、方法、路由模板、状态或错误分类，不记录 bearer、query、body、SQL 或原始 SDK 异常。

## 验证

```sh
pnpm check
pnpm test:integration
pnpm probe:mcp
pnpm probe:evaluation
```

真实数据库测试会在驱动器提供的专用测试实例中新建随机测试库和临时低权限角色，标记后清理自身数据库，不截断原始测试库。默认临时 Docker PG17 满足所需 CREATE DATABASE/ROLE 权限；使用外部 DATABASE_URL 跑测试时，测试账号需具备这些权限，不能使用正式运行账号。

本地覆盖身份签名、错误 token、JWKS 重定向、bootstrap、跨项目引用、当前权限/撤销、并发幂等、后续写入失败回滚、版本取消/重复取消、API 重建持久化、迁移历史及运行账号无 DDL。也有真实 loopback HTTP 请求；多数路由组合使用 Fastify 的注入测试，不伪装成公网或完整 SSO 验收。

P0 的 SQL/库组合验证继续保留，新增 migration SQL 也纳入源码证据指纹。独立 P1-A 测试通过不会替代 VM 隔离、真实 Keycloak、外部 MCP、Worker 或完整三条闭环的阶段出口。
