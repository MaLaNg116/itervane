# P5-B3 · 干净参考安装的正式审计导读

本批将参考安装的真实登录和数据库接到前一批安装的 KVM Runner，再由外部 MCP 核对同一份正式审计。现有无 Runner 的等待流程继续作为独立验收。 [本批计划](../plans/p5-reference-audit.md) · [前置 PR #163](https://github.com/MaLaNg116/itervane/pull/163)

1. `b9a9971` 复用原生联验的受限进程启动、终止和等待逻辑。运行账号仍是登记的 Worker，敏感环境变量经标准输入交给子进程。 [Worker 进程](https://github.com/MaLaNg116/itervane/blob/b9a9971/packages/control-plane/test/native/scoped-worker.ts)
2. `e30cac6` 复用真实 PostgreSQL 17、Keycloak 26.8.2 和 Chrome 的参考安装。浏览器提交固定源码任务并读正式记录，独立 PKCE 令牌通过只读 MCP 读回同一运行、源码快照和扫描摘要。模型使用本地 Anthropic 协议测试服务，正式 Worker 的工具和预算仍在执行。 [参考安装联验](https://github.com/MaLaNg116/itervane/blob/e30cac6/packages/portal/test/native/reference-install.ts)
3. `8a68cdd` 将正式审计放入托管 `protected-release-linked-health` 场景，先通过参考安装器，再核对 VM 和临时目录回收。只保留安装、身份、模型范围及结果摘要。 [托管验收](https://github.com/MaLaNg116/itervane/blob/8a68cdd/.github/workflows/native-runner.yml)

本地通过 TypeScript、287 项单测、门户构建和原有干净安装。实测真实 PostgreSQL、Keycloak、Chrome、初始口令更新、双语门户、独立 MCP 读权限及 Runner 不可用时的暂停。原生测试模式在本地被拒绝，实际 VM 和有 Runner 的审计分支交由托管作业验证。此批覆盖一次正式审计，P5 完整开发、运维与规则复用的参考安装验收仍待后续批次验证。
