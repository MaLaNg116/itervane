# P2-D3-D-D1 · 复验查询 Review Guide

本批以 [受控返修 #36](https://github.com/MaLaNg116/itervane/pull/36) 为比较基线。项目成员可从 HTTP 和外部 MCP 查询同一份正式复验视图。 [实施计划](../plans/p2-d3-d-verification-read-side.md)

1. `4bb0d12` 定义响应契约。当前 run 可以等待、暂停核对、取消或具有正式结论。独立记录的来源对比、构建、健康检查与镜像均使用已知的字段和状态。上一代记录必须紧邻当前返修代次。 [公共 DTO](https://github.com/MaLaNg116/itervane/blob/4bb0d12/packages/contracts/src/verification-view.ts)
2. `bc32ee1` 用同一服务处理两个入口。事务使用任务和项目权限的共享锁，在任务范围内重算输入、结果及 Runner 回执的摘要和复验事实。上一代结果还需与返修记录中的候选、回执和结果摘要对应。 [授权查询](https://github.com/MaLaNg116/itervane/blob/bc32ee1/packages/control-plane/src/service/verification-view.ts) · [证据读取](https://github.com/MaLaNg116/itervane/blob/bc32ee1/packages/control-plane/src/runtime/verification-evidence.ts)
3. HTTP `GET /v1/tasks/:taskId/verification` 使用 API 身份，MCP `get_verification` 使用绑定 MCP audience 的 `itervane:read` 权限。两者还校验当前项目成员关系。中文和英文取决于请求语言。响应提供有界状态、检查事实、镜像发现计数和证据摘要。 [HTTP 入口](https://github.com/MaLaNg116/itervane/blob/bc32ee1/packages/control-plane/src/api.ts) · [MCP 入口](https://github.com/MaLaNg116/itervane/blob/bc32ee1/packages/control-plane/src/mcp.ts)
4. `b1b68d3` 用 PostgreSQL 和真实外部 MCP SDK 检查两代查询、双语结果、独立读 scope、跨项目和已撤权的访问。临时修改测试库中的第一代结果指纹时，HTTP 与 MCP 都按完整性错误响应。 [双代次验证](https://github.com/MaLaNg116/itervane/blob/b1b68d3/packages/control-plane/test/integration/inspections.test.ts) · [协议与授权验证](https://github.com/MaLaNg116/itervane/blob/b1b68d3/packages/control-plane/test/integration/mcp.test.ts)

本机 TypeScript 与 `b1b68d39d7f6655654fd26af481dcddda29299f2` 的 136 项真实 PostgreSQL 17 集成测试通过。源码指纹为 `eb525985491abb0a084a0980d511e0c6d0a6c8964ebe0da94884339039af97ee`。首轮全量 135 项通过，既有制品检查点恢复用例有一次提前停止。该用例独立复跑八次通过，同一固定版本后续整套重跑也通过。本地尚未定位这次偶发的原因。 [托管原生回归](https://github.com/MaLaNg116/itervane/actions/runs/44909041398)

D-D2 接续门户中的双语复验历史和交互验收。P2-E 按同一候选的实际制品与人工决定完成发布验收。

四组托管原生回归通过。双代次 503、第二代归档和历史回归的源码指纹与 PostgreSQL 复跑一致。最终提交 `15035dd4a395c50b1d4465960d7a2dc58d28341e` 的常规 CI 检查通过，源码与原生验收版本一致，以 `4c2e785268d72866a141cdd330726000bedc6471` 合入 `main`。 [原生验收](https://github.com/MaLaNg116/itervane/actions/runs/44909041398) · [合并记录](https://github.com/MaLaNg116/itervane/pull/37)
