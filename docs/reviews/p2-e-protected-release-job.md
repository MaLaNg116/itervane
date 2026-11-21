# P2-E-D3-D2-B · 同一任务的真实发布验收导读

依赖 [真实受保护入口 #61](https://github.com/MaLaNg116/itervane/pull/61)。固定代码版本 `1951f4d1d6184529c5fe1a5c4e0d180c7ca16eb9`。 [分批计划](../plans/p2-e-protected-release-workflow.md)

1. 复用原生 Runner 的返修场景。外部 MCP 发起固定源码任务，第一候选触发真实 503，自动返修后按当前代次取得独立复验和 OCI 归档。保留首轮失败与最终复验的不同快照和回执。 [源任务与返修](https://github.com/MaLaNg116/itervane/blob/78097c7/packages/control-plane/test/native/worker-inspection.ts)
2. 登记实际 Registry、Komodo 目标和受保护入口。MCP 请求冻结候选，绑定当前复验、镜像和入口指纹。审批前确认没有发布操作，非门户身份被拒绝，再以签发给测试门户的所有者身份确认。 [目标登记与决定](https://github.com/MaLaNg116/itervane/blob/78097c7/packages/control-plane/test/native/worker-inspection.ts)
3. 专用 UID 运行打包后的正式发布入口，用当前 Runner、已登记目标、固定 Registry 工具和测试 CA。PostgreSQL、Komodo 容器回读、HTTP 和两种语言的 MCP 核对同一操作。操作 `verified_formal` 后验证镜像、原生更新、实际版本和受保护健康。证书仅用于本轮 HTTPS，服务密钥和数据库 URL 通过进程输入传递。 [安装态入口](https://github.com/MaLaNg116/itervane/blob/ebcba24/packages/control-plane/src/entries/release-worker.ts)
4. 单独的 `protected-release` 场景使用专用托管 KVM 主机，要求真实运行成功。最后以 Runner 身份独立校验留存 OCI 的权限和摘要。四组已有场景继续覆盖故障恢复和隔离。 [托管入口](https://github.com/MaLaNg116/itervane/blob/ebcba24/.github/workflows/native-runner.yml) · [宿主脚本](https://github.com/MaLaNg116/itervane/blob/ebcba24/fixtures/runner/run-qualified-session.sh)

本机 TypeScript、202 项单元和宿主脚本语法检查通过。验收报告明确记录模型使用脚本夹具、控制面使用签名 OIDC 夹具、应用入口使用真实 Keycloak。第二类修复经实际发布、审批后漂移和发布过程故障验收进入 D3。

首轮托管任务进入正式上线核验，因健康检查失败转入人工处理。入口夹具使用默认应用端口 3000，OCI 运行计划写入端口 38171。`1951f4d` 将登记的入口与实际 OCI 端口对齐。 [首轮记录](https://github.com/MaLaNg116/itervane/actions/runs/44956661850/job/137006171176) · [OCI 构建端口](https://github.com/MaLaNg116/itervane/blob/1951f4d/packages/runner/host/runtime_guest.py#L31)

修正后的同一任务发布已通过。PostgreSQL 17.12 证据记录两代候选、首轮复验失败、返修改变补丁、最后一项发现清零。正式安装 Worker 使用同一操作完成镜像导入和原生部署，真实受保护入口的健康状态为 200、匿名状态为 401。审批身份限制、镜像匹配、两种语言的 HTTP/MCP 对照、工作区清理及独立归档摘要均通过。报告源码指纹 `7feb2439d4f68a978c617ce959c2b0799c47a5dca196cab0485fc30165438a61`。 [真实 KVM 发布证据](https://github.com/MaLaNg116/itervane/actions/runs/44957996813/job/137010357391)
