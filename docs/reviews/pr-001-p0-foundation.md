# PR #1：P0 起步底座 Review guide

- PR：[交付 Itervane 起步底座与验证记录](https://github.com/MaLaNg116/itervane/pull/1)。
- 对应代码：`1025303f6596de9c46ba02d8c74e4131a9ce797d`，后续文档补充不改变这一代码快照。
- 比较基线：`64f1ecf39ebd66860cfb8b2f74c435d7a44c7b94`。
- 原始代码交付：17 个中文 Conventional Commits；2026-11-16 的 push 与 PR CI 均通过。
- 本 guide 整理于 2026-11-18，来自聊天中的逐模块讲解。

## 1. 先确认本次做到了哪里

这次建立 P0 验证底座，分别验证契约、模型工具循环、MCP、PostgreSQL/队列/图检查点以及评测材料。它没有串起完整平台。62 个变更文件中，约 55% 新增行来自锁文件。

```text
packages/contracts/       共享契约及初版治理约束
packages/verification/    P0 模型、数据库、MCP、环境、评测与证据检查
fixtures/standard-app/    被平台拿来验证的标准目标应用
evaluation/              案例输入、预期与独立判定依据
scripts/                 统一检查入口
.github/workflows/       无真实服务密钥的 CI
docs/                    设计、开发计划和已观察结果
```

五种角色目前只有标识。模型循环、数据库接收原型和 LangGraph 检查点恢复仍是独立实验；OIDC、正式任务 API、Runner、扫描器、Komodo、Whiskers、完整领域 Agent 尚未实现。

## 2. 工作区和入口

先读 [package.json](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/package.json#L9) 和 [tsconfig.json](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/tsconfig.json#L6)。

pnpm workspace 管理两个包和标准应用。`workspace:*` 引用本地包；`private: true` 防止意外发布 npm 包，不影响 GitHub 开源属性。运行时是 Node.js 24，TS 使用 NodeNext 和严格模式。

`noUncheckedIndexedAccess` 让数组读取可能为空的问题暴露到类型层；`exactOptionalPropertyTypes` 区分缺省字段与显式 undefined。这里直接用 tsx 执行验证程序，没有承诺生产打包流程。

| 命令 | 入口及行为 |
|---|---|
| `pnpm check` | `scripts/check.ts`：类型检查后运行单元测试，记录结果 |
| `pnpm test:integration` | `scripts/test-postgres.ts`：准备真实 PG17 后运行数据库测试 |
| `pnpm probe:model` | `entries/model.ts`：读取忽略提交的本地模型配置 |
| `pnpm probe:mcp` | `entries/mcp.ts`：本地官方 SDK HTTP 互通 |
| `pnpm probe:evaluation` | 评测材料检查、标准应用构建和 HTTP 测试 |
| `pnpm verify:p0` | 读取已有报告并检查时间和源码指纹 |

`entries` 中几行薄包装只负责调用探针及设置退出码，行为集中在对应模块，避免每个命令复制错误处理。

## 3. 契约：能接受什么输入，承认什么状态

读 [contracts/src/index.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/contracts/src/index.ts#L11)。

Zod 承担运行时校验，`z.infer` 生成 TS 类型。`startTaskSchema` 绑定仓库 ID 和固定 Git commit，限定首期为模拟或公开数据；`.strict()` 拒绝客户端追加批准、主体或密钥字段。完整 Git 对象 ID 只能是 40 或 64 个十六进制字符。

这些只是输入形状：UUID 格式正确不表示项目存在或调用者有访问权。仓库实际登记和认证上下文尚未实现。

`mayApprove` 要求人类主体、当前项目范围及批准能力。正式服务必须从可信认证上下文构建 actor；不能直接信任客户端传入的 actor。

`wakeupSchema` 只放任务、run 和执行代次，排除密钥与批准。`transitions` 定义允许的状态转换；状态名存在不表示已经有持久化状态机。

`toolResultSchema` 区分成功、业务错误、基础设施错误、等待批准和结果未知。远端操作超时可能已经生效，unknown 必须核对；不能直接当失败重放副作用。本次没有实现真实远端操作。

检查点：[契约测试](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/contracts/test/unit/contracts.test.ts) 是否覆盖客户端自带授权、生产数据、取消转换以及缺失证据。

## 4. 模型适配：统一内部消息，保留协议差异

读 [types.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/model/types.ts#L14) 和 [adapters.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/model/adapters.ts#L40)。

循环只依赖 `ModelAdapter.complete`，传入 system、conversation、tools、signal，得到 text、calls、tokenUsage。适配器将其转换成 Anthropic 的 tool_use/tool_result 或 OpenAI Chat Completions 的 tool_calls/tool 消息。

callId 把一次工具请求与观察结果关联，不能丢失。两个 SDK 均关闭隐藏重试。模型 URL 禁止嵌入凭证，明文 HTTP 仅允许 loopback；fetch 禁止重定向，避免把凭证转发给其他目标。OpenAI 缺 usage 时失败，不能当成零消耗。

两个协议都通过本地响应夹具测试；实际模型工具循环通过的是 Anthropic 兼容端点。协议兼容不表示某家模型服务已经认证。

## 5. 工具循环：模型选择下一步，代码检查能否执行和完成

重点逐行读 [loop.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/model/loop.ts#L23)。

```text
目标与已有观察 → 模型响应 → 响应结构和预算检查
  → 工具名/参数检查 → 执行工具 → 观察写回 conversation → 下一轮
  → finish_audit → acceptFinish 校验证据 → 接受完成或返回拒绝观察
```

for 循环限制轮次；业务路径由模型根据观察决定，并非按固定步骤顺序调用工具。

第 39 行检查取消，第 44 行校验模型结构，第 47 行累计 token；第 52 行逐个处理工具请求，再次检查取消和调用次数。找不到工具或 Zod 参数不通过时，代码返回错误观察，不执行工具。第 71 行执行合法工具，第 78 行把真实结果写回会话。

提示词表达意图，代码落实已实现的约束。模型说“已批准”不会产生批准权，也没有宿主 shell 或容器变更工具可以调用。

默认最多 6 轮、12 次工具请求、16,000 token 判断阈值；相同序列化工具和参数第三次出现即停止。token 阈值在响应后判断，不能当作绝对费用硬上限。重复判断是初版规则，尚无完整语义进展分析。

`finish_audit` 是完成申请，必须由外部传入的 acceptFinish 接受。Loop completed 表示当前探针正确结束，不能推断应用恢复或任务获准发布。

检查点：[循环测试](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/test/unit/model-loop.test.ts) 覆盖观察反馈、虚假完成、无效工具/参数、重复、工具前取消和预算。调用中的取消及生产工具授权仍需正式 Harness 继续落实。

## 6. 真实模型探针：用随机观察证明防止空口完成

读 [probe.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/model/probe.ts#L21)。

每个场景生成随机 proof，只有调用相关工具才能获得：

```text
健康：inspect_service → finish_audit(healthy, 实际 proof)
故障：inspect_service → read_logs → finish_audit(needs_human, 实际 proof)
```

acceptFinish 检查输出结构、proof、决策和真实轨迹。只返回一句“检查通过”不能通过。故障场景 completed 表示已经按证据要求人工介入，没有修复服务。

实际调用了模型，但工具提供模拟只读观察；没有访问真实云机日志、控制 Docker 或执行代码。2026-11-16 两条路径分别计量 518 / 806 tokens，不代表其他模型或未来版本自动通过。

## 7. 数据库原型：原子入队与幂等

读 [database.ts 第 51 行](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/database.ts#L51)。

领域接收记录与 pg-boss 唤醒通过同一 Drizzle 事务提交，关键是 `queue.send(..., { db: fromDrizzle(tx, sql) })`。不能先保存领域任务再单独入队，否则中间崩溃会丢唤醒；反过来也可能产生孤儿队列消息。

数据库唯一约束为 `(project_id, principal_id, request_key)`。重复请求返回原任务；同一 key 改变快照哈希则冲突。当前哈希只覆盖 snapshot，负载也是 P0 简化版本；正式服务需完整请求指纹与正式契约。

领域、队列和检查点分别使用随机 schema。关闭时只删除本次生成的 schema；拒绝对普通应用库运行测试。这里的手写建表是实验装置，不是可直接升级的正式迁移。

## 8. 执行权、租约与等待锁期间过期

读 [database.ts 第 67 行](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/database.ts#L67)。

只有一行 execution_slot。acquire 使用条件 UPDATE 抢占，递增 generation，设置短租约。A 持有代次 1、卡住后租约过期，B 获得代次 2；A 恢复后仍拿着代次 1，不能提交正式观察。

recordObservation 在短事务内先 `FOR UPDATE` 锁定执行权行，再检查 owner、generation 和 lease。不能在等待锁前完成检查，因为等待期间租约可能过期。

对应[锁等待测试](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/test/integration/database.test.ts#L71) 让一个连接占锁、另一连接等待，等待时租约失效，最终写入必须被拒绝。

这只保护原型中的数据库观察写入。正式工具调用前的代次检查、环境变更协调和远端核对尚未实现，不能单靠一次 isCurrent 查询授权后续写入。

## 9. 崩溃与 LangGraph 恢复是两项独立验证

读 [database.test.ts 第 104 行](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/test/integration/database.test.ts#L104)。

队列测试启动真实子 Worker 进程、让其领取任务、实际终止进程，然后等待超时并运行 pg-boss 巡检。原任务重新领取、重试次数递增；重领不等于取得正式领域执行权。

第 155 行的图测试是 interrupt → PG 保存 → 关闭 saver → 新 saver 连接 → 相同 thread_id + Command resume。它证明图检查点能跨连接恢复。

runProbeLoop 目前没接这个 saver。完整 Worker、Agent 循环、领域状态与授权恢复还没有串联。断言“样例状态没有 approved 字段”不是完整审批安全证明。

## 10. MCP：协议、临时认证与同进程重连

读 [mcp.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/mcp.ts#L11)。

本地 Node HTTP 服务注册 create_probe_task/get_probe_task。进入 MCP 前验证路径、Host、Origin、临时 bearer 和请求体大小。官方 SDK 客户端创建任务、断连、重新连接、查询并重复创建，结果 ID 必须一致。

额外验证无凭证 401、错误 Origin 403。任务存储是 Map；进程重启后丢失，尚未连接正式 PG、项目授权或 OAuth/OIDC。它也不是 Whiskers 运维客户端。

## 11. 标准应用与评测材料

读 [标准应用](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/fixtures/standard-app/server/app.mjs#L4)。

app.mjs 创建 Express 应用，index.mjs 负责监听和退出，便于测试用临时端口。health、version、demo 分别检查健康、实际版本和模拟数据。React 构建资源由相同 Express 服务提供，形成单镜像目标。

启动配置 unhealthy 让进程存活但 health 返回 503；startup-failure 直接退出。没有 HTTP 切换故障的管理接口。Dockerfile 准备多阶段构建、生产依赖与非 root 用户，但镜像发布尚未实测。

再读 [evaluation.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/evaluation.ts#L41)。24 个案例提供输入和独立判定依据，6 个 holdout 不参与调优。源码变异必须在白名单路径中唯一匹配，当前仅在内存中验证，不执行变异代码。

probeEvaluation 实际构建并测试可信原始样例。24 个平台场景尚未执行，材料准备通过不能计为 Agent 成功率。公开 split 也不保证模型从未见过数据。

## 12. 证据、环境与 CI

读 [report.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/report.ts#L11)、[readiness.ts](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/packages/verification/src/readiness.ts#L12) 和 [CI](https://github.com/MaLaNg116/itervane/blob/1025303f6596de9c46ba02d8c74e4131a9ce797d/.github/workflows/verification.yml#L19)。

报告有运行 ID、时间、逐项结果与指定源码/配置/锁文件指纹。readiness 拒绝缺失、超过 24 小时、源码不匹配、汇总不一致的报告。passed/failed/blocked 分别是 0/1/2；本地可修改的报告不承担正式批准和防篡改审计职责。

cloud.ts 使用固定只读 SSH 脚本，保持 StrictHostKeyChecking。候选云机无 KVM，因此完整隔离与原生运维仍待验；没有 native-operations 报告是如实状态。用户决定本轮不补充云机，不据此删除安全边界。

CI 使用固定 Action SHA、只读权限、冻结锁文件，在 Linux 运行确定性检查，不拿真实模型/云机密钥。结果包括 32 项单元测试、11 项 PG 集成测试、5 项标准应用测试；实际模型另有两条观察路径通过。

测试配置 maxWorkers=1 限制测试资源，不替代平台全局执行槽位。CI 成功不代表 P0 完整验收。

## 建议 Review 顺序

优先逐行看 loop.ts、model/probe.ts、database.ts 与数据库集成测试，再看契约、适配器、MCP 和证据汇总。确认每个“通过”都能对应实际断言；再核对文档明确列出的待验事项。

后续批次继续沿用 [交付与 Review 约定](README.md)，不需要靠聊天记录拼接各批设计。
