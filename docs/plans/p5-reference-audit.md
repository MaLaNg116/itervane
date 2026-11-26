# P5-B3 · 在干净参考安装中完成一次正式审计

本批把参考控制面的真实身份和数据库接到参考 KVM Runner。由浏览器登录的维护者登记公开示例、提交固定 Git 版本、完成扫描与正式审计，并通过独立授权的外部 MCP 读回同一审计。 [参考控制面 #162](https://github.com/MaLaNg116/itervane/pull/162) · [参考 Runner #163](https://github.com/MaLaNg116/itervane/pull/163)

1. 扩展现有干净安装联验。继续用 `reference:prepare/init/start` 启动真 PostgreSQL、Keycloak 和 API，保留当前无 Runner 用例。真实 Runner 用例由托管场景显式选择，接收已启动的专用 socket 和镜像摘要。运行正式 Worker 时沿用登记 UID 和受限数据库账号，凭证只经受保护的进程输入传递。
2. 用门户提交仓库固定提交，等待独立 VM 生成扫描证据。由现有 Anthropic HTTP 测试服务提供结构化模型响应，保留真实 Worker 的模型适配器、证据工具和运行预算。核对正式审计的运行、源码快照和扫描摘要，读回记录，同时确认虚拟机和临时工作区已回收。
3. 走 Keycloak PKCE 的外部 MCP 读权限。比对门户与 MCP 的任务、扫描和审计记录，确认中英文消息可读、令牌受众隔离。托管报告标明安装、模型、身份、KVM 与任务摘要的实测范围，保留原有执行资格约束。

完整开发正向路径继续要求修复、独立复验、批准、真实发布和受保护访问。后续批次在同一参考安装上接入 Registry、Komodo 和 Whiskers，独立复跑开发与运维路径并验证规则复用。本批审计证据不计入完整开发正向路径的三次运行。
