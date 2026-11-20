# P1-B 调度、受控执行骨架与外部 MCP

- 日期：2026-11-18；范围见 [P1-B 计划](plans/p1-b-durable-execution-and-mcp.md)。
- 基线仍为 [v6](blueprint-v6.md) 与 [TS + PostgreSQL 实施计划](implementation-plan-v2-ts-postgresql.md)。
- 前置安装见 [P1-A](control-plane-p1-a.md)；设计决定见 [运行资格](decisions/0001-development-and-runtime-gates.md)、[检查点发布](decisions/0002-checkpoint-publication.md)。

本文保留 P1-B 的历史交付范围；后续最小门户、浏览器登录和真实 Keycloak 验证见 [P1-C](control-plane-p1-c.md)。下文“尚无门户”等内容描述 P1-B 固定版本。

## 实际能力

`API/MCP 接收任务 → 原子入队 → Worker 领取 → 受控读取登记信息 → 检查 Runner 能力 → 保存真实图 interrupt → waiting_input 并释放槽位 → 查询/人工重试/取消 → 重启后恢复`

这是 P1 的持久化 preflight 骨架，使用真正的 pg-boss、领域表和 LangGraph PostgresSaver。它不调用模型、不拉取仓库、不执行项目命令。没有已验证的虚拟机 Runner 时，准确停在 `runner_unavailable`，不会报告审计完成。P2 继续按 v6 在这一外层治理骨架内实现自主选择工具的 Agent Harness。

完整 P1 和 MVP 尚未验收。门户、浏览器登录、真实 Keycloak OAuth、规则查询/预审、Runner、扫描器、批准/operation ledger、发布和运维 MCP 等仍需后续实施。

## 启动和升级

前置为 Node.js 24、pnpm 11.9.0、PostgreSQL 17。升级前停止 API/Worker 并备份平台库；本批没有滚动升级或备份恢复演练。

1. 安装锁定依赖，使用专用迁移账号执行 `pnpm db:migrate`。
2. 迁移增加执行权/预算/语言、checkpoint 回执和 step，由官方 saver 初始化独立 checkpoint schema。历史 SQL 不改写。
3. 对实例选定的运行角色重新执行/核对 `packages/control-plane/ops/runtime-grants.sql`，包含三个 schema 的 USAGE、表 DML 和序列使用；不授予 CREATE。
4. 初次安装按 P1-A 执行 `pnpm bootstrap:owner`；已有 owner 的实例跳过。
5. 分别启动两个进程：

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm db:migrate
# 完成管理员授权；首次安装再 bootstrap:owner
pnpm start:api
```

另一终端运行 `pnpm start:worker`。维护者需配置自己的外部身份服务，测试 JWKS 不是交付的身份服务器。部署时分别注入所需配置，API/Worker 不应取得迁移凭证；本机共用 `.env` 只是开发便利。

| 配置 | 用途 |
|---|---|
| `DATABASE_URL` | API/Worker 低权限账号，连接同一平台库 |
| `ITERVANE_MIGRATION_DATABASE_URL` | 仅迁移进程使用 |
| `ITERVANE_OIDC_ISSUER` | 固定 realm issuer/JWKS |
| `ITERVANE_OIDC_AUDIENCE` | API audience，例如 itervane-api |
| `ITERVANE_PUBLIC_URL` | 固定公开 origin；MCP resource 为此值加 /mcp，默认 http://127.0.0.1:4310 |
| `ITERVANE_API_HOST` / `ITERVANE_API_PORT` | 默认 127.0.0.1:4310 |
| `ITERVANE_WORKER_LEASE_SECONDS` | 2–60 秒，默认 10 |
| `ITERVANE_WORKER_POLL_MS` | 100–10000 毫秒，默认 1000 |

Worker 不需要 OIDC 或模型密钥。公开 origin 仅支持根路径，远端必须 HTTPS；canonical URL 不从 Host/代理头推导。TLS/反向代理与公网部署仍需另外验证。

API 领域池 4 + 队列池 2；Worker 领域池 4 + 队列池 2 + saver 池 2。两个独立进程合计最多 14 个运行连接，迁移/测试另计；增加进程前重新预算连接。

## 状态与执行权

全局 `execution_slot` 只有一行。领取事务校验当前 task/run generation、wakeup ID 和数据库权限，完成唤醒，再登记 running、短租约和递增 fence。它不在事务内执行图节点。

队列完成只表示唤醒已处理，任务仍可能 running 或 waiting_input；领域记录决定业务状态。忙时重发延迟唤醒，不占用槽位等待。

心跳、工具入口/结果、checkpoint 读写都锁定同一执行权，取得锁后重新读取 PostgreSQL 时钟。generation 是逻辑 run 代次，fence 是每次领取的执行权代次。旧 Worker 不能提交结果或开始新工具；过期租约也不能重新续活。

Worker tick 恢复过期执行权，并修复 queued 任务丢失或终止的唤醒。恢复需要存活或替换的 Worker 轮询；没有 Worker 时不会自行运行，数据库故障期间也不承诺固定秒数恢复。

| 操作 | 语义 |
|---|---|
| queued/waiting_input 取消 | 校验版本，原子取消领域状态及可用唤醒 |
| running 取消 | 先 cancel_requested，立即拒绝新工具/普通 checkpoint；Worker 或过期恢复随后确认 cancelled |
| Runner 暂停 | 真正 interrupt/checkpoint 发布后 waiting_input，并释放 slot |
| resume | 只重试 Runner preflight；校验当前权限、expectedVersion、已发布 checkpoint 和等待原因，再原子入队 |
| 重复 resume | 同版本仅一次生效；不重置语言、run 或预算，最多 3 次 |
| 撤销权限 | 下一次领取、心跳、工具或普通 checkpoint 重新检查；安全停止允许清理已有执行权 |
| 子任务等待 | 内部原语检查同项目、自等和循环等待并释放 slot；公开 spawn、结果交接和自动唤醒留待角色协作 |

新增 HTTP 为 `POST /v1/tasks/:taskId/resume`，与 cancel 一样提交 `{ "expectedVersion": <当前版本> }`。resume 不代表批准，不会开启 Runner。进程终止也不伪装成用户取消，剩余任务按租约恢复。

## 检查点与工具

领域 runtime 发布具体 checkpoint ID 和图 step，恢复不取 saver latest。底层 checkpoint 已提交而领域回滚时，残留数据没有执行资格；pending writes 必须匹配领域发布回执。图 step 防止进度倒退，PostgresSaver 的 channel version 分配防止未发布分支污染重算 blob。详见 ADR 0002。

本批仅验证根命名空间和受信任 JSON 状态。历史查询、时间旅行、DeltaChannel 与子图尚未交付；P2 扩展需继续验证对应接口和序列化，不能将其当作通用 LangGraph 服务。

| 内部工具 | 实际行为 |
|---|---|
| `project.describe` | 读取当前任务绑定的真实项目 ID、仓库 ID、固定 commit、数据类别，生成观察引用 |
| `source.inspect` | 返回 business_error / runner_unavailable，不声称已读取或扫描源码 |
| 其他工具/其他目标参数 | 拒绝；没有 shell、Docker socket、依赖安装或宿主运维入口 |

调用前预留账本并原子扣减持久预算，默认 8 次。相同 key/输入返回已提交结果，改变输入冲突。未完成的只读预留可重放且不重复扣预算；并发重算收敛到同一结果。账本只保存参数哈希和允许的工具名，结果和事件同样受 fence 约束。

这是只读目录、目标约束和预算基础。P2 的角色/阶段策略、模型 token/时间预算、批准绑定、远端副作用和未知结果核对仍需实现。checkpoint 或只读去重不构成副作用 exactly-once 保证。短事务只覆盖数据库读写，不覆盖模型、远端工具或人工等待。

## 外部 MCP

入口 `/mcp` 使用官方 TS SDK v2 HTTP handler、Node 适配器和 stateless 请求上下文。任务来自 PostgreSQL，API 重建/重连不依赖进程内 Map。所有命令复用 TaskService 和当前数据库项目权限。

匿名发现为 `/.well-known/oauth-protected-resource/mcp`。401 challenge 带 resource_metadata，缺 scope 返回 403 challenge。平台不签发 token、不接受 query token，不把 token 转发给项目工具。

- API token audience：`ITERVANE_OIDC_AUDIENCE`。
- MCP token audience：`ITERVANE_PUBLIC_URL` + `/mcp`。两类 token 不自动互通。
- MCP 基础 scope 为 `itervane:read`，写工具还需 `itervane:write`；scope 不扩大项目权限。
- 仅接受固定 issuer 的 RS256 JWT Bearer access token。真实 Keycloak realm、客户端注册和浏览器 OAuth 全流程仍待集成。

Host 只允许配置主机或 loopback，出现 Origin 时必须精确匹配公开 origin。代理须保留/设置匹配的 Host；任意 forwarded identity 不成为身份依据。

| 工具 | 输入 | scope |
|---|---|---|
| `start_audit` | 与 POST /v1/tasks 相同，先登记资源并固定 Git ID/请求键 | read + write |
| `get_task` | taskId | read |
| `get_task_events` | taskId，可选 limit（默认 50，上限 100） | read |
| `cancel_task` | taskId、expectedVersion | read + write |
| `resume_task` | taskId、expectedVersion | read + write |

只读 token 的发现只展示查询工具，直接调用写工具仍被拒绝。业务/校验错误返回 isError、统一错误结构；底层协议语法错误由 SDK 处理。没有外部 MCP 部署、批准、shell 或内部工具调用端点。

## 多语言

先支持 `en`、`zh-CN`，共享资源类型检查两种语言键完整，后续可扩展。

| 内容 | 规则 |
|---|---|
| 展示语言 | Accept-Language 协商，缺省/不支持回退 en；HTTP 返回 Content-Language |
| 任务输出语言 | 输入 locale，缺省 en，持久化；请求头不会改变它 |
| 错误 | 稳定 code/messageKey，翻译 message、locale、服务端 requestId |
| 事件 | 稳定 type/state/reason；查询时翻译 message/reasonMessage；区分 principal/worker |
| MCP | 工具描述、结果说明、业务错误和事件按展示语言返回 |
| 不翻译 | 字段名、状态码、Git ID、ISO 时间、用户输入、规则 ID、机器日志 |

旧任务默认英语，旧默认英语请求保留相同幂等指纹；非默认 locale 属于任务输入，同键改语言冲突。响应新增 locale、文案和 reason 字段，严格旧响应 schema 的客户端需同步升级共享契约。本批没有门户，不宣称浏览器国际化完成。

外部命令的 actorKind 为 principal，表示已认证主体；JWT 本身不证明人在场，也不代表审批。后续人类确认需独立实现，不能从本批事件类别推断。迁移 0004 将早期 human 标签规范为 principal，不改变主体 ID 或事件业务内容。

## 验证

```sh
pnpm check
pnpm test:integration
pnpm probe:mcp
pnpm probe:evaluation
```

正式测试覆盖全局竞争、行锁等待/过期 fencing、丢失首个 checkpoint/唤醒、取消/撤权、预算/预留重放/恢复事务回滚、实际图中断、未发布 checkpoint/pending writes/blob、图 step，以及杀死实际 Worker 后重领。MCP 使用官方外部客户端和 loopback HTTP，验证权限、语言、重连及 API/连接重建后联合恢复。

固定版本、数量和阅读路径见本批 review guide。测试 Docker 只运行可信 PG17；真实 Agent、VM Runner、Komodo、Whiskers、发布/运维及规则复用继续按 v6 推进。
