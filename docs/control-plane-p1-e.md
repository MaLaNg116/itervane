# P1-E：规则查询与有限文本预审

- 日期：2026-11-19；[实施计划](plans/p1-e-rules-and-preaudit.md)、[ADR 0005](decisions/0005-limited-text-preaudit.md)、[review guide](reviews/p1-e-rules-preaudit.md)。
- 沿用 P1-A/B/C 的身份、数据库、API、Worker 与门户，本批新增迁移 `0006_preaudits.sql` 和内部 workspace 包 `@itervane/rules`，没有新增外部 npm 依赖。

## 实际路径与资格

`真实 OIDC 登录 → 项目 → 查询规则/Skill → 固定目录摘要提交有限文本 → 保存预审 ID → API/MCP/门户查询同一报告 → 切换显示语言`

预审是短请求中的确定性文本匹配，不调用模型，不启动 Agent、CLI 或用户代码，不获取仓库、不应用补丁。它不创建业务 task/run，不进队列、不占执行 slot。原有业务任务仍在未验证的 Runner 闸门暂停。

所有材料都是 advisory。报告的 `formalScan` 和 `releaseEligible` 固定为 false；`no_observations` 只表示在这次有限匹配中没有观察，不表示安全、通过审计或获得发布批准。

## 升级与启动

1. 停止旧 API/Worker，按既有流程备份专用平台数据库。
2. 使用锁文件安装依赖，由独立迁移账号运行 `pnpm db:migrate`。既有 0000—0005 不修改，新迁移可在已有 P1-D1 数据库上追加。
3. 管理员重新核对/执行 `packages/control-plane/ops/runtime-grants.sql`，将新表纳入运行角色授权；运行角色继续没有 DDL 或 TRUNCATE。
4. 重建门户，启动同一 API/Worker。OIDC、数据库连接池、迁移账号与运行账号沿用 P1-C/P1-B，不增加 Runner enable、模型或新服务凭证。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm db:migrate
# 管理员核对运行角色的新表授权
pnpm build:portal
pnpm start:api
# 另一终端 pnpm start:worker
```

0006 创建 `itervane.preaudits`、项目/主体外键、幂等唯一键、项目历史索引、绑定与大小 CHECK，以及拒绝 UPDATE/DELETE 的触发器。触发器是手写迁移，Drizzle snapshot 不跟踪其实现。历史任务/检查计划不因迁移自动获得预审结果。

`/v1/capabilities` 的 stage 更新为 `p1-e`，新增 `ruleQuery: true`、`limitedTextPreaudit: true`、`autonomousAgents: false`。旧的 `sourceSnapshots/sourceScanning/taskExecution/sandbox/deployment/operations` 仍为 false；严格校验 capability 的客户端需同步共享契约。

## 只读材料目录

| ID | 类型 | 实际能力 |
|---|---|---|
| text-dynamic-eval | check | JS/TS 单行中匹配 eval 调用形态，返回 suspected |
| text-html-sink | check | JS/TS 中匹配 innerHTML/dangerouslySetInnerHTML 文本，返回 suspected |
| text-check-allow | check | 观察到字面 gitleaks:allow 标记，返回 observed_text；不证明平台扫描可被绕过 |
| server-authorization-context | guidance | 提供服务端授权检查指导，不执行鉴权分析 |
| bounded-review-context | skill | 提供审阅上下文与证据边界指导，本批不运行 Agent |

每条材料有 ID、版本、类型、适用语言、Apache-2.0 原创说明、参考来源、双语指导与限制、内容 SHA-256。目录另有版本、引擎版本和整体摘要。参考链接用于注明依据，查询和预审不会访问这些链接。

语言过滤只改变查询返回的材料列表，目录 SHA-256 始终代表完整目录。提交预审必须带完整目录摘要；检测器由服务端固定，不能上传自定义正则、脚本、插件或 claimed approval。Skill 不能扩大权限、预算或审批资格。

更新内置检查需通过后续软件版本和代码 review，并相应更新规则/目录/引擎版本。摘要绑定双语内容和检测定义；文字翻译变化也会改变目录摘要。它目前不是 P4 的在线规则管理或发布系统。

## API 与外部 MCP

HTTP 使用既有 API audience；MCP 使用独立 MCP audience。所有入口调用同一 RuleService/PreauditService，并重新检查当前主体和项目权限。

| HTTP | MCP 工具 | 权限与结果 |
|---|---|---|
| GET /v1/projects/:projectId/rules | list_rules({projectId, language?, catalogSha256?}) | 当前项目 read；目录及本地化材料 |
| GET /v1/projects/:projectId/rules/:ruleId | get_rule({projectId, ruleId, language?, catalogSha256?}) | 当前项目 read；单条材料 |
| POST /v1/preaudits | preaudit_text({...input}) | owner/maintainer；创建报告和 ID，或重放原报告 |
| GET /v1/preaudits/:preauditId | get_preaudit({preauditId}) | 当前所属项目 read；本地化详情 |
| GET /v1/projects/:projectId/preaudits?limit=100 | list_preaudits({projectId, limit?}) | 当前项目 read；最新记录，最多 100 条 |

MCP 查询另需 `itervane:read`；创建另需 `itervane:read` + `itervane:write`。只读工具列表不会向只读 scope 暴露预审写工具，伪造直接调用也被拒绝。访问未知、其他项目或已撤权的记录不能绕过领域授权。

POST 与 `preaudit_text` 的输入相同：

```json
{
  "projectId": "项目的 UUID",
  "idempotencyKey": "本次请求固定的 UUID",
  "catalogSha256": "查询取得的完整目录 SHA-256",
  "language": "typescript",
  "format": "snippet",
  "dataClass": "synthetic",
  "text": "eval(value);"
}
```

示例中的 UUID/摘要需替换为正式值。`language` 为 javascript/typescript/json/text；`format` 为 snippet/unified_diff；`dataClass` 为 synthetic/public。分类是调用方声明，服务端不能凭此证明输入没有私人数据。

HTTP 创建成功返回 201，重放返回 200，均为 `{report, replayed}`；MCP 返回同一结构化结果。显示语言使用 `Accept-Language: en` 或 `zh-CN`，未支持语言按既有策略回退。它不进入语义输入，不改变 report ID/hash、规则版本或首次提交渠道。

## 输入与覆盖限制

- 非空、合法 Unicode 纯文本，最多 16 KiB UTF-8、1000 输入行；允许 TAB/LF/CRLF，拒绝其他受限控制字符和孤立 CR。API 还有既有 64 KiB 请求体上限。
- diff 仅支持单文件文本 unified diff，可带有限 Git prelude；验证文件头、hunk 计数、范围与顺序，只分析新增行。多文件、binary、畸形计数或不支持结构明确拒绝。
- diff 路径仅作为不透明语法，不读取、不应用、不持久化，不证明文件存在或补丁可用。`inputLine` 是提交文本中的行，`sourceLine` 是新增行声明的新文件行号；片段没有正式源码行号。
- 最多保存 100 个观察，达到截断条件会显示 `partial` 与 `observation_limit`。无新增行、语言不适用、仅有指导材料与完成有限检查分别记录。
- 这是固定单行文本形态匹配，字符串/注释可命中，多行、别名、混淆或真实数据流可能漏报。suspected 不是可利用漏洞的证明，observed_text 也只证明看到字面文本。
- 完整仓库、依赖漏洞、密钥有效性、PII、完整鉴权、运行时行为与业务逻辑均未覆盖。结果明确列出 formal_scanners/repository_context/runtime_behavior/semantic_analysis，diff 另列未改动行未检查。

## 持久化、并发与隐私

创建在一个短事务内完成当前授权、纯有限匹配、报告写入。`(project_id, requested_by, request_key)` 唯一；并发请求由数据库裁定，冲突后读取已提交原记录。没有外部等待、长模型调用、独立队列或另一套执行锁。

同主体、同项目、同 UUID 键及相同语义输入重试，API/MCP 均返回原 ID。片段、格式、语言、数据类别或目录摘要改变会产生幂等冲突。新请求使用旧目录摘要返回 conflict；合法历史重放先读取原记录，不因当前目录升级而丢失。

报告保存服务端提供的完整规则内容快照、目录/引擎版本、输入指纹与有限机器结果。查询从历史快照本地化，核对 document、主体/项目绑定和规范化哈希；不使用当前目录覆盖历史规则。CHECK 的 `IS TRUE` 防止缺字段通过 SQL NULL；不可变触发器拒绝运行角色 UPDATE/DELETE。这些约束不承诺抵御数据库管理员篡改，也不是外部签名。

原文、文件名、diff 路径、匹配摘录不写入数据库、事件、checkpoint 或应用请求日志。报告只包含服务端材料与位置；输入 SHA-256 用于内容比对，不证明仓库来源，也不是匿名化或加密，低熵文本仍可能被猜测。因此仅提交公开或模拟文本。

门户原文仅在组件、待重试 ref 和请求内存中保留；不作为 query key/mutation variables，不存 localStorage/sessionStorage。首次提交前锁定同一 UUID/内容；响应丢失后明确重试原请求，成功清空并跳转。也可明确清空后新建请求，项目历史可用于核对已接收记录。离开页面、登出或撤权会卸载私人输入；浏览器刷新不会恢复原文。

该保证覆盖本项目的应用实现，不自动约束自托管反向代理、外部助手或浏览器扩展的日志策略；部署方应沿用不记录请求体的配置。

## 验证与后续

```sh
pnpm check
pnpm test:integration
pnpm test:portal
```

浏览器依赖与镜像要求沿用 P1-C。新增用例使用真实 Keycloak、PostgreSQL、HTTP、官方 MCP 客户端和 Chrome，检查双语查询/报告、跨入口同一 ID、原文不落库/存储、文本不渲染执行、响应丢失同键重试、只读/撤权、diff 新增行与中文 UTF-8 限额。浏览器脱敏报告沿用 `.reports/p1-c/browser.json`，新截图位于忽略目录 `.reports/p1-e/`。

本批完成 P1.5 的规则查询/有限预审切片。P2-A 继续负责具备动态工具选择、模型预算、上下文和停止条件的自主 Agent；P4 负责规则/Skill 上传、候选验证、人审发布/回滚及后续复用。D2/D3 继续负责真实 VM 和固定源码扫描，不能用这批文本请求代替。完整 P0/P1/MVP、真实发布和运维仍待验。
