# P0 验证、兼容性与未通过事项

- 记录日期：2026-11-16。
- 阶段：P0 进行中，尚未完整验收；P1 未开始。
- 对应：[开发计划 v1](development-plan-v1.md)、[实施计划 v2](implementation-plan-v2-ts-postgresql.md)。

2026-11-18 补充：下文保留 2026-11-16 的 P0 观测快照。按 [ADR 0001](decisions/0001-development-and-runtime-gates.md)，独立 P1-A 身份/资源/任务模块已进入开发，见 [控制面说明](control-plane-p1-a.md)；这不改变 VM 隔离与原生集成仍待验、完整 P0 未通过的事实。

2026-11-20 新增 P0.5-A 原生证据。固定 Komodo 2.3.4 已在专用工作机完成样例发布 A、升级 B 和恢复 A，三轮均核对 OCI、实际容器和 HTTP 健康。完整 P0 还有真实 VM 隔离、Whiskers 原生确认与兼容基线验收。 [Komodo 导读与复跑](reviews/p0-komodo-native-delivery.md)

2026-11-20 新增 P0.5-B 原生证据。固定 Whiskers 0.15.0 已完成真实 MCP 观察、未批准阻断、独立浏览器身份批准、同参单次重启和审计核对。完整 P0 仍需真实 VM 隔离、原生授权到期实测和兼容基线验收。 [Whiskers 导读与复跑](reviews/p0-whiskers-native-approval.md)

## 1. 本轮实际实现

`@itervane/contracts` 提供固定 Git 输入、五种角色标识、初版任务状态转换、主体能力判断、唤醒与工具结果契约。`@itervane/verification` 包含模型协议适配、受限观察循环、MCP/数据库/云机/评测探针和本地证据汇总。它们都是 P0 验证模块。

模型循环根据工具结果继续调用并校验最终观察证明，提供取消、turn/token/tool-call 上限和重复停止。当前工具为模拟只读检查；尚无领域 Agent、生产工具网关或基础设施操作能力。正式 Harness 将在 P2 使用 P1 的授权、持久化和执行基础。

数据库原型只在专用数据库内生成随机测试 schema，验证 Drizzle + pg-boss 同事务、幂等、领取竞争、执行槽位及代次、取消、有限重试、进程终止后超时重领和 LangGraph 恢复。没有正式平台迁移、OIDC、审批服务或任务 API。

MCP 是真实官方 SDK 客户端/服务端的 localhost HTTP 冒烟检查，具有临时 bearer、Host/Origin 校验和重连。探针任务存在进程内 Map，重连只证明同一进程中的协议行为；P1 才接入正式持久化、项目授权和 OAuth/OIDC。它不提供生产远程接入。

## 2. 复现命令

前置：Node.js 24（本机 24.14.0）、pnpm 11.9.0；真实 PG 测试需要可用的 Linux Docker engine，或专用 PostgreSQL 17 数据库。

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm check
pnpm test:integration
pnpm probe:mcp
pnpm probe:evaluation
```

| 命令 | 保存的报告 | 证明范围 |
|---|---|---|
| `pnpm check` | `.reports/p0/engineering.json` | 严格类型与确定性单元/协议测试 |
| `pnpm test:integration` | `.reports/p0/database.json` | 真实 PG17 的事务、队列、代次和恢复机制 |
| `pnpm probe:mcp` | `.reports/p0/mcp.json` | 本地认证、Origin 拒绝及官方客户端重连 |
| `pnpm probe:evaluation` | `.reports/p0/evaluation.json` | 24 个案例材料检查、可信样例的真实本机构建与 HTTP 测试 |
| `pnpm probe:model` | `.reports/p0/model.json` | 所选实际模型的工具调用、观察分支和完成证据；需要本地配置 |
| `pnpm probe:cloud` | `.reports/p0/cloud.json` | 严格主机校验下的只读环境检查，不能证明 VM 生命周期 |
| `pnpm verify:p0` | `.reports/p0/readiness.json` | 汇总当前源码的本地证据；缺失项不放行 |

退出码：`0` 通过，`1` 失败，`2` 缺少条件或阻塞。报告有运行 ID、时间和源码指纹；汇总要求 24 小时内且指纹一致。源码变化后旧报告失效；`.reports` 是本地验证辅助，不是可信审批记录，P1 另建正式领域事实与事件。自动测试通过不能代替 P0 关键闸门的真实证据。

数据库测试默认创建临时、仅 localhost 端口的自有 PG17 容器，随机测试密码通过进程环境传入，数据在 tmpfs；结束时核对本次 UUID 标签后只清理自身容器。可以配置 `DATABASE_URL` 使用专用数据库，但名称只能是 `itervane_test` 或 `itervane_p0`（可加字母数字后缀），并需有创建/删除测试 schema 的权限。不要指向普通应用数据库；P0 的测试 DDL 权限不代表正式运行账号应有 DDL。

官方 PG17 镜像候选锁定为：

```text
postgres:17@sha256:0d938e975177bef9f1f61f3f9dbcf2e0aa0a139568f66d3415ed8892eb97f6ac
```

本机 Docker registry 拉取遇到网络/TLS 问题，使用官方 manifest/layer 校验后导入的等价本地镜像完成测试。Linux amd64 manifest 为 `sha256:6f7593c161689b6b02c78668b314af7da8811b592c5519108c57a49d0b6ad788`，实测服务端 17.12。该替代仅处理测试镜像获取；它没有替代 VM 隔离或宣称完成正式安装。需要替代镜像引用时只在忽略提交的本地配置填写 `ITERVANE_POSTGRES_IMAGE`。

## 3. 可选本地配置

复制 `.env.example` 为 `.env`，只在本机填写实际信息。`.env`、日志和 `.reports` 均忽略提交。

- `MODEL_PROVIDER=anthropic` 或 `openai`，配对应的 `*_API_KEY`、`*_MODEL`、`*_BASE_URL`。每次探针只选一种协议，不自动回退。首轮按用户确认的 Anthropic 协议；HTTP 仅允许 localhost，其他端点要求 HTTPS，不接受 URL 内凭证或查询参数，禁止跟随重定向转发密钥。
- `ITERVANE_VALIDATION_SSH`、可选 `ITERVANE_SSH_PORT`、`ITERVANE_SSH_IDENTITY`：只读预检使用本机 SSH。必须已有经核对的 known_hosts；脚本不关闭主机身份校验，不打印目标地址、用户名或私钥路径，不安装软件。
- `DATABASE_URL` 仅用于明确的专用测试库；未配置时使用临时 Docker 容器。

不用模型或云机也可执行确定性检查，但相关 P0 闸门保持未验证。`/v1/models` 能列出模型不代表实际推理、工具调用或预算可用；官方 SDK 对本地假响应的测试也不能替代真实模型。

## 4. 2026-11-16 验证记录

| 项目 | 已观察结果 | 限制及下一步 |
|---|---|---|
| 严格 TS 与确定性测试 | 32 项单元测试通过，含协议、工具循环、契约和证据汇总 | 不是生产 Harness、授权或领域任务的验收 |
| PostgreSQL 17.12 | 11 项集成测试通过，无 SQLite 替代 | 使用隔离原型 schema；正式迁移与运行权限待 P1 |
| 原子性和幂等 | 回滚无领域记录/队列孤儿；并发相同请求只有一个任务和唤醒；变更内容冲突被拒绝 | P0 只测接收事务，完整批准事务和副作用核对待后续 |
| 失效写入与竞争 | 全局槽位竞争、旧代次拒收、等待锁期间过期的租约拒收 | 不可把 `isCurrent` 的只读查询单独当正式写入授权；写入须在锁内重新检查 |
| 队列重试与恢复 | 重试耗尽终止；子 Worker 实际被终止后由监督巡检识别超时并重领 | 超时不是即时重领，受巡检周期影响；重领仍需领域代次检查 |
| LangGraph | PostgreSQL 保存 interrupt，通过新 saver 连接恢复 | 不是完整 Worker 重启后的领域恢复；恢复不授予审批权 |
| MCP | 未认证 401、错误 Origin 403、官方客户端重连/幂等三个检查通过 | 临时探针认证与内存状态，不是生产 OAuth 或持久化任务 API |
| 标准应用 | Vite 构建和 5 项真实 HTTP/启动/静态资源检查通过 | Dockerfile 已准备但镜像构建、受保护入口和真实部署未验证 |
| 评测材料 | 24 个案例（6 个 holdout）及源码变异匹配检查通过 | **24 个平台场景尚未执行**；按 P1—P5 接入，不计为 Agent 成功率 |
| 本地实际模型 | 之前实际推理请求超时；本次通过 Anthropic 协议完成健康/故障两条真实观察路径，分别计量 518 / 806 tokens | 健康路径仅 inspect，故障路径 inspect → logs，最终随机证明匹配；OpenAI 适配仅通过协议夹具，未进行实际模型验证 |
| 候选云机 | Linux 可 SSH；KVM 设备不可用、CPU 虚拟化标志未开放、virsh 缺失 | P0.4 阻塞；不以 Docker 或未验证的替代隔离放行 |
| Komodo / Whiskers | 尚未执行原生发布、版本恢复、确认后重试 | P0.5 阻塞；没有 `native-operations.json` 是预期状态，不补造通过报告 |

云机隔离及原生集成的关键条件未满足，**P0 不通过，P1 不进入正式实现**。没有因这次环境问题删减三条闭环、MCP、Agent 运维或安全边界。

## 5. 当前候选依赖组合

版本来自锁文件和实际安装包。下表许可栏是包 manifest 的声明元数据，不代表已完成整个分发的许可审查；第三方服务、扫描规则、模型服务及传递依赖分别核对。P0.7 完整兼容/镜像基线尚未冻结。

| 依赖 | 精确版本 | manifest 许可 | 当前证据 |
|---|---|---|---|
| TypeScript / Vitest / tsx | 7.0.2 / 5.1.0 / 4.23.15 | Apache-2.0 / MIT / MIT | 本机严格检查和测试 |
| `@anthropic-ai/sdk` | 1.8.0 | Apache-2.0 | 协议夹具及实际兼容端点工具循环通过 |
| `openai` | 7.57.0 | Apache-2.0 | 本地协议夹具通过；实际推理未通过 |
| `@langchain/core` / `@langchain/langgraph` | 1.4.1 / 1.7.4 | MIT | 图与 PG 检查点恢复测试 |
| `@langchain/langgraph-checkpoint-postgres` | 1.1.3 | MIT | 新连接恢复测试 |
| `@modelcontextprotocol/client` / `server` | 2.4.0 / 2.4.0 | Apache-2.0 | 官方 SDK HTTP 互通 |
| `@modelcontextprotocol/node` | 2.1.2 | Apache-2.0 | Node HTTP 适配及 Host/Origin 校验 |
| `drizzle-orm` | 0.45.4 | Apache-2.0 | 与 pg-boss 真实事务适配 |
| `pg` / `pg-boss` | 8.23.1 / 12.38.2 | MIT | PG17 测试；显式短事务与随机 schema |
| `zod` | 4.6.7 | MIT | 入站/工具/清单/报告校验 |
| React / React DOM | 19.3.1 / 19.3.1 | MIT | 可信示例生产构建 |
| Vite / Express | 8.3.8 / 5.3.0 | MIT | 构建及真实 HTTP 测试 |

Fastify、门户组件、Keycloak、Traefik、Registry、Komodo、Whiskers、libvirt 及扫描器尚未作为正式平台集成，本轮不宣称它们的版本组合通过。选定兼容协议不等于已选定或认证任何具体模型。

## 6. P0 剩余出口

1. 首轮实际 Anthropic 协议的工具循环已通过；模型/协议/配置改变时重新验证。OpenAI 协议如要作为正式任务配置，还需补充实际模型证据。
2. 准备支持 KVM 的 Linux 宿主，完成 VM 创建、资源/出口限制、执行、重置、销毁、越界与残留验证。只读预检成功不能代替这些证据。
3. 在隔离、登记的测试目标验证 Komodo 的发布/版本恢复及 Whiskers 原生 MCP 确认闸门。平台确认与下游确认关联，固定目标/动作/参数；响应未知时先核对。
4. 验证标准镜像构建与受保护部署，补全适配器和 Runner 契约、正式 P0.7 版本/协议/许可记录。
5. 为每个关键闸门保存真实关联记录，再按实施计划验收。当前 readiness 的 `native-operations` 报告没有生成器，需实现真实测试驱动器后生成；不支持手工填一个成功状态作为过关。

GitHub Actions 仅运行无需真实密钥的类型、协议、PG 和可信样例检查。CI 通过不会伪造云机或下游变更证据，也不会自动开始 P1 或部署任何服务。
