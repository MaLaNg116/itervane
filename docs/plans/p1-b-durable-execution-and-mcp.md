# 下一批 P1-B：持久化调度、受控执行骨架与外部 MCP

- 状态：代码和本地验收已完成，交付证据见本批 review guide；前置代码为 `f332826`，使用独立叠加 PR，不自动合并前置交付。
- 前置：[P1-A 计划](p1-a-project-task-foundation.md) 与对应 review guide；仍遵守 ADR 0001。

| 任务 | 目标 | 验收重点 |
|---|---|---|
| B1 执行权 | 正式任务/run 代次、短租约和心跳、全局执行槽位、重领及失效写入拒收 | 两个 Worker 仅一个有效；旧代次不能写结果或发新工具；崩溃恢复不依赖内存 |
| B2 暂停/取消/恢复 | 领域事件与 PostgreSQL checkpointer 核对、取消停止新增工具、人工暂停释放槽位 | 重复恢复、失效授权和状态竞争被处理；父任务等待子任务不占槽死锁 |
| B3 工具网关 | 项目/目标/有效 run/预算/副作用目录与结构化结果；先支持受信任只读工具 | 测试使用真实领域记录；没有虚拟机证据时项目源码执行明确 blocked，不返回伪扫描结果 |
| B4 外部 MCP | 对外 task start/query/events/cancel，复用 P1-A 身份及领域服务；协议认证/能力发现 | 正式任务 ID；重连和 API 重启后状态一致；跨项目和取消不被 MCP 绕过 |
| B5 导读与故障验证 | 新迁移、Worker 进程测试、恢复证据、独立 guide 和叠加 PR | 分项中文提交，完整 P1/项目未通过项继续列出 |

本批之后再安排门户与浏览器登录、Runner 和真实扫描器、Agent 角色及真实发布/运维。没有支持隔离的环境时，可以开发适配器契约和可信测试，但运行用户项目与高影响动作不放行，完整 P0/P1/P2 验收继续待真实环境。

## 本轮明确的实现边界

执行骨架是持久化 preflight 图，不替代 P2 的自主 Agent Harness。Worker 经 pg-boss 接收唤醒，取得领域执行权，读取真实登记信息，经工具网关检查源码能力；因为尚无已验证 Runner，任务进入 waiting_input 并保存真正的 LangGraph PostgreSQL interrupt。人工 resume 只代表重试前置检查，不能批准发布或打开 Runner。

队列只调度唤醒。领取事务完成唤醒并登记短租约；Worker 崩溃由领域恢复扫描重新入队。全局 slot 仅一行，不按队列或进程各放一个执行者。task/run generation 表示逻辑 run，slot fence 每次取得执行权递增；两个值都在执行/写入前校验。

## 需求拆分与验收

| 提交单元 | 实现 | 主要验收 |
|---|---|---|
| B0 多语言契约 | en/zh-CN 资源、语言协商、持久化任务 locale、机器码与展示文案分离 | 资源键完整；HTTP/MCP 双语；默认英语兼容旧幂等请求；locale 不扩大权限 |
| B1 迁移与执行权 | 单 slot、短租约/心跳、fence、runtime/预算/工具账本、恢复扫描 | 两 Worker 竞争；旧 fence 写/调用拒绝；忙时延迟唤醒；丢唤醒和崩溃恢复 |
| B2 领域控制 | running 取消、暂停释放、版本化 resume、父子等待原语 | 并发 resume 一次生效；暂停/父子等待释放 slot；权限撤销与预算不可重置 |
| B3 Checkpointer/工具网关 | 受执行权约束的 saver、领域发布 checkpoint ID、已知只读工具、预算与结果分类 | 未发布 checkpoint 不用于恢复；取消后无新工具；未知/高影响动作拒绝；无虚假扫描 |
| B4 Worker | 独立进程、真实 PG 图执行/中断/恢复、心跳、恢复扫描及关闭 | 杀死真实 Worker 后可重领；实际检查点跨连接恢复；任务在 Runner 闸门处等待 |
| B5 外部 MCP | 正式 start/query/events/cancel/resume，复用领域服务，认证与元数据发现 | 官方 SDK 连入；重连/API 重建仍查到同任务；错误 aud/scope/Origin/项目均拒绝 |
| B6 交付 | CI、运行说明、固定代码导读、交付索引 | 中文 Conventional Commits，独立草稿 PR，完整 P1 待验项列明 |

## 检查点与故障窗口

按 [ADR 0002](../decisions/0002-checkpoint-publication.md) 管理 checkpoint：领域记录发布具体 checkpoint ID；保存前后短事务检查 fence；图与数据库事务分开，不在模型/工具等待期间持锁。不能仅凭 checkpointer 的 latest 或 interrupt 授予权限。

工具账本按逻辑调用 key 去重，并原子扣减持久预算。受信任只读元数据可重放；未验证的项目代码、任意命令、容器/宿主操作全部返回明确阻断。暂停和恢复都不会重置预算。

## 多语言

先支持 `en` 与 `zh-CN`，保持资源目录可扩展。Accept-Language 只选择 HTTP/事件/MCP 展示语言；任务输入的 locale 决定后续报告语言，缺省 en，并写入领域表。更改请求头不改任务 locale、幂等键、权限或机器状态。

错误返回稳定 code/messageKey、翻译 message、locale 和 requestId。事件保存稳定类型/参数，在查询时翻译。项目名、用户输入、Git ID、规则 ID、ISO 时间和日志机器码不自动翻译。此批没有门户界面，不宣称浏览器多语言已完成。

## 外部 MCP 与认证

服务采用已验证的官方 SDK v2。配置固定 public URL 与 canonical `/mcp` resource audience；JWKS 继续来自固定 issuer，API token 与 MCP resource audience 分开校验。实现 Protected Resource Metadata 和 401/403 challenge；授权服务器仍复用外部 Keycloak，不自研登录或 token 签发。

MCP 每次请求重新建立身份上下文，状态来自 PostgreSQL，不用进程内 Map 作任务存储。read/write scope 是传输层约束，实际项目权限仍查领域记录。端到端 OAuth 浏览器授权与真实 Keycloak realm 留作后续实证，不能以本地签名夹具替代。

## 测试原则

复用真实 PG17 临时数据库/低权限运行角色。新增调度竞争、过期 fencing、暂停/恢复/取消、预算、checkpoint 未发布故障窗口、实际进程终止及外部 MCP SDK 测试。预期中的 waiting_input 是诚实结果，不能为得到 succeeded 而添加假 Runner 或跳过闸门。
