# 021 · P1-D3-C2 正式源码检查与恢复导读

实现基线为 [#20 的合并提交 `8bfc71d`](https://github.com/MaLaNg116/itervane/commit/8bfc71d3ed081175541de87c384442a3a8ed6bf0)。本批把已验收的独立 Runner 接入正式 Worker、执行权和任务证据账本。 [分批计划](../plans/p1-d3-worker-inspection.md) · [PR #21](https://github.com/MaLaNg116/itervane/pull/21)

## 1. 从任务到一次隔离检查

1. 门户和外部 MCP 仍把项目、仓库与固定 Git 提交交给同一任务服务。Worker 通过 PostgreSQL 租约和检查点运行前置检查。工具目录中的 `source.inspect` 只接收空参数，来源从当前项目登记读取。调用预留只扣一次预算。 [任务调度](../reviews/p1-b-durable-worker-mcp.md) · [工具入口](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/runtime/tools.ts#L25) · [Worker 图](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/runtime/worker.ts#L80)
2. Runner 必须在独立 Linux 用户下提供受保护的本机 socket，校验 Worker 的 Unix 凭据、精确 HTTPS 白名单和可信镜像。这批为一次检查预留不可替换的 PostgreSQL 记录，绑定任务、仓库、提交、计划、run、代次、fence 和工作区指纹。工作区身份包含本次宿主启动和当前目录身份。 [预留与绑定](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/runtime/source-inspection.ts#L61) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/migrations/0009_inspection_attempts.sql) · [工作区约束](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/migrations/0010_inspection_workspace.sql)
3. 每次授权心跳都复核当前租约、项目权限、尝试记录和原仓库登记。隔离运行在短数据库事务之外，取消、撤权和进程退出会使心跳失效。源码检查节点收到停止信号后等待 Runner 结算回收，租约有效时可先记账再释放执行槽位。 [Worker 心跳授权](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/runtime/source-inspection.ts#L102) · [客户端协议](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/runner/src/qualified-client.ts) · [Worker 停止处理](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/runtime/worker.ts#L99)

## 2. 从回执到任务证据

1. Runner 结束隔离工作后核对 QEMU 已退出、libvirt 域已消失、暂存文件已清理。Worker 检查回执的任务和尝试绑定、来源与镜像摘要、固定 Git 树和扫描策略。发现项使用受限字段及归一化指纹。 [回收条件](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/runner/host/libvirt_probe.py#L394) · [正式回执校验](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/service/inspection-evidence.ts#L26)
2. 回执、工具结果和任务事件同一事务写入，提交前再次核对执行权。事件保存 run、工具调用键的摘要与检查请求 ID 的关联。授权失效时，当前执行者只可记录已确认清理或结果未知。旧 fence 的回执无法写入正式证据。 [正式提交](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/runtime/source-inspection.ts#L136) · [工具与事件](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/runtime/tools.ts#L65) · [原子性及撤权回归](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/test/integration/inspections.test.ts)
3. 重领同一个 run 时可以复用已记录证据。前一次尝试仍待核对时，控制器必须观察到原工作区、空的 libvirt 会话及空的暂存目录，新 fence 才能关闭旧尝试并预留一次新的检查。工作区身份变化、存在残留或观察不可用时保留核对状态。进程身份未获证实时保留清理日志，留待维护者在宿主核对。 [只读核对](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/runner/host/qualified_controller.py#L91) · [重领与重试](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/runtime/source-inspection.ts#L65)

## 3. 用户会看到什么

HTTP `GET /v1/tasks/:taskId/source-inspection` 和 MCP `get_source_inspection` 共用领域查询并检查当前项目权限。双语门户展示计划、检查中、清理待核对、扫描完成或覆盖不完整。结果只公布回执摘要、快照摘要、文件数、各扫描器状态、统计与覆盖限制。任务在检查完成后等待审计阶段，覆盖不完整时提示人工核对。重新核对使用现有的授权恢复和次数限制。 [共享服务](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/service/inspections.ts#L30) · [API](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/api.ts#L166) · [MCP](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/control-plane/src/mcp.ts#L81) · [门户](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/packages/portal/src/pages/task.tsx#L107)

## 4. 验收记录

Windows 本机通过 107 项单元测试和 91 项真实 PostgreSQL 17 集成测试。Linux 通过 108 项 TypeScript、39 项 Runner、91 项 PostgreSQL、21 项真实浏览器及离线扫描测试。回归覆盖事务回滚、同一工作区重领、取消、撤权、旧 fence、两种语言和存量检查点。 [分支常规 CI](https://github.com/MaLaNg116/itervane/actions/runs/44771578808) · [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44771587898)

首次原生测试发现，图在撤权后可先于本机 Runner 返回，导致 Worker 提前释放当前执行槽位。修正后用 PostgreSQL 回归验证租约有效期间的收尾结算。本次原生验证使用 `7895719`、临时 PostgreSQL 17.12、正式 Worker 进程和 30 秒数据库租约。独立 watcher 观察 QEMU 的 pidfd，确认实际客体停止。 [首次原生运行](https://github.com/MaLaNg116/itervane/actions/runs/44763798641) · [正式原生验收](https://github.com/MaLaNg116/itervane/actions/runs/44771579026)

| 原生用例 | 实测结果 |
| --- | --- |
| MCP 启动固定版本检查 | Git 提交 `9167604` 有 305 个源文件，Gitleaks 报告 1 项，Trivy 报告 6 项。HTTP 与 MCP 返回相同的回执及快照摘要。 |
| 取消与撤回项目授权 | 两个正在运行的实际客体均退出，工作区清空，数据库结算两次尝试并保留停机状态。 |
| Worker 进程崩溃 | 原 QEMU 退出。新 Worker 在同一工作区把 fence 4 的尝试结算，并在 fence 5 复扫固定快照。新旧扫描的快照摘要一致，新尝试产生独立回执。 |
| 独立回归 | 五个正式 Worker 域与十四个既有隔离用例的实际域互不重复。下载的 `kvm-host-evidence` 核对了源码指纹、镜像、扫描覆盖、回收及授权状态。 |

## 5. 复跑与运行范围

`pnpm check` 检查类型和单元测试，`pnpm test:integration` 运行真实 PostgreSQL，`pnpm test:portal` 使用真实 Keycloak 和浏览器。Linux Runner 测试使用 `python3 -B -m unittest discover -s packages/runner/host`。正式 Worker 入口通过 `ITERVANE_RUNNER_SOCKET`、`ITERVANE_RUNNER_UID`、`ITERVANE_RUNNER_IMAGE_SHA256` 同时配置已验收的本机控制器。未配置时任务仍可准备计划并进入可恢复等待。 [运行配置](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/.env.example) · [托管验证工作流](https://github.com/MaLaNg116/itervane/blob/9dee1d03a374cc189dddb00cadee964d2d64bf63/.github/workflows/native-runner.yml)

首批 Worker 使用同一台宿主上的同一个检查控制器，支持维护者显式登记的公开 HTTPS Git 源、完整 SHA-1 提交和当前镜像所带的 Gitleaks、Trivy。证据记录固定 Git 树和快照清单，源码工作目录随虚拟机回收。宿主重启或工作区被替换时，旧尝试需经维护者核对。Semgrep、可修改工作区、独立复验、应用发布和 Agent 运维还有各自的接入与验收。 [D3-C 总计划](../plans/p1-d3-qualified-inspection.md) · [蓝图 v6](../blueprint-v6.md)
