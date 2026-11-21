# P2-E-D3-D3-B · 正式发布对象变更验收

接续 [第二类修复验收](p2-e-protected-release-coverage.md)。复用固定标准应用、真实 PostgreSQL、独立 KVM 复验、正式 MCP 冻结与门户确认。两项负例分别创建任务，在已确认且发布排队后引入变更，再启动安装态发布 Worker。

1. 更新已登记的健康检查目标与指纹。让 Worker 校验当前安装配置，证明旧指纹下的操作在获取执行权前结束为 `release_target_changed`，未产生 Registry 或 Komodo 写入意图。
2. 使用当前目标和新决定。仅在托管测试目录，以 Runner 账户把本轮留存文件暂时替换成等长的合成数据。要求实际归档传输拒绝该数据，操作以 `release_archive_unavailable` 阻断。结束后恢复原文件，由 Runner 身份独立核对原摘要与封存权限。
3. 每个操作都用 PostgreSQL 时间线、真实 Registry 查验、原生 Komodo 目标及容器回读、双语 HTTP/MCP 结果对照。核对审批历史仍可追溯、任务进入人工处理、执行槽与工作目录已清理。

临时替换工具限定于本轮专用托管 KVM 目录和固定归档描述。发布 Worker 使用正常的安装入口。D3-C 在已派发写入和实际上线时覆盖运行故障与进程中断。
