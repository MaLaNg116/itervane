# P2-E-D3-D3-B · 批准后目标与工件变更导读

依赖 [第二类修复发布 #63](https://github.com/MaLaNg116/itervane/pull/63)。固定代码版本 `c109dae43b0cd379afdc06a91f1835cc10343cbe`。 [分批计划](../plans/p2-e-protected-release-drift.md)

1. 固定源码分别完成两次隔离构建与 OCI 复验。证据就绪后由真实 MCP 冻结，再经门户批准。第一项在操作排队后更新登记的健康检查端口与指纹。安装态 Worker 加载新登记，拒绝仍绑定旧目标的决定。 [候选、批准与目标变化](https://github.com/MaLaNg116/itervane/blob/a3b017f/packages/control-plane/test/native/worker-inspection.ts)
2. 第二项使用新的任务、有效决定与当前登记。在本轮专用目录由 Runner 账户暂时替换留存文件。替换文件字节数、模式和文件名相同，内容摘要不同。真实 Worker 停止后恢复原文件，并以 Runner 身份独立校验原始摘要。 [合成归档替换](https://github.com/MaLaNg116/itervane/blob/a3b017f/fixtures/runner/release-drift-archive.py) · [宿主归档核对](https://github.com/MaLaNg116/itervane/blob/06a692e/fixtures/runner/run-qualified-session.sh)
3. 两项都核对 PostgreSQL 的审批历史、拒绝原因、空外部步骤和释放的执行槽。再读真实 Registry 和 Komodo，确认镜像清单不存在、目标与容器未变动，并对照中英两种语言下的 HTTP 和 MCP 结果。 [托管验收](https://github.com/MaLaNg116/itervane/blob/06a692e/.github/workflows/native-runner.yml)

本机 202 项单元、TypeScript、Bash 与 Python 语法检查通过。使用本机临时目录验证了等长替换与原文件恢复，托管 KVM 完整验收待归档。

首轮托管运行通过目标变化检查，随后在归档场景停下。`c109dae` 修正了步骤断言，要求归档读取停在 `prepared`、回执为空、Registry 与 Komodo 写入步骤均为零，并在本轮替换就绪后记录单独的检查阶段。 [首轮记录](https://github.com/MaLaNg116/itervane/actions/runs/44959277739/job/137014257705) · [修正](https://github.com/MaLaNg116/itervane/commit/c109dae43b0cd379afdc06a91f1835cc10343cbe)
