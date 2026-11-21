# P2-E-D3-D2-B · 同一任务的真实发布验收导读

依赖 [真实受保护入口 #61](https://github.com/MaLaNg116/itervane/pull/61)。固定代码版本 `ebcba24d2f376dbbc7405098029279d0a51c6a2a`。 [分批计划](../plans/p2-e-protected-release-workflow.md)

1. 复用原生 Runner 的返修场景。外部 MCP 发起固定源码任务，第一候选触发真实 503，自动返修后按当前代次取得独立复验和 OCI 归档。保留首轮失败与最终复验的不同快照和回执。 [源任务与返修](https://github.com/MaLaNg116/itervane/blob/78097c7/packages/control-plane/test/native/worker-inspection.ts)
2. 登记实际 Registry、Komodo 目标和受保护入口。MCP 请求冻结候选，绑定当前复验、镜像和入口指纹。审批前确认没有发布操作，非门户身份被拒绝，再以签发给测试门户的所有者身份确认。 [目标登记与决定](https://github.com/MaLaNg116/itervane/blob/78097c7/packages/control-plane/test/native/worker-inspection.ts)
3. 专用 UID 运行打包后的正式发布入口，用当前 Runner、已登记目标、固定 Registry 工具和测试 CA。PostgreSQL、Komodo 容器回读、HTTP 和两种语言的 MCP 核对同一操作。操作 `verified_formal` 后验证镜像、原生更新、实际版本和受保护健康。证书仅用于本轮 HTTPS，服务密钥和数据库 URL 通过进程输入传递。 [安装态入口](https://github.com/MaLaNg116/itervane/blob/ebcba24/packages/control-plane/src/entries/release-worker.ts)
4. 单独的 `protected-release` 场景使用专用托管 KVM 主机，要求真实运行成功。最后以 Runner 身份独立校验留存 OCI 的权限和摘要。四组已有场景继续覆盖故障恢复和隔离。 [托管入口](https://github.com/MaLaNg116/itervane/blob/ebcba24/.github/workflows/native-runner.yml) · [宿主脚本](https://github.com/MaLaNg116/itervane/blob/ebcba24/fixtures/runner/run-qualified-session.sh)

本机 TypeScript、202 项单元和宿主脚本语法检查通过。完整托管场景待验。验收报告明确记录模型使用脚本夹具、控制面使用签名 OIDC 夹具、应用入口使用真实 Keycloak。第二类修复经实际发布、审批后漂移和发布过程故障验收进入 D3。
