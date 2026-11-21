# P2-E-D3-D1 · 受保护发布目标的原生验收导读

依赖 [门户与 MCP 双语发布结果 #59](https://github.com/MaLaNg116/itervane/pull/59)。固定代码版本 `a994e216d1ffeabc473d3ab3b85aeeef59a4f5e9`。 [本批计划](../plans/p2-e-protected-release-e2e.md)

1. 原生 Komodo 夹具为每个目标创建带唯一归属标记的 Docker 内部桥接网络。登记目标前按 Docker ID 核对名称、驱动、内部模式和标签。 [网络创建与核对](https://github.com/MaLaNg116/itervane/blob/a994e216d1ffeabc473d3ab3b85aeeef59a4f5e9/packages/verification/src/native/komodo-probe.ts#L52)
2. Komodo 更新结束后，读取实际容器的镜像摘要和网络绑定，要求容器只加入登记网络、没有宿主机端口映射，也未启用特权模式。正式适配器用正确网络读取运行证据，用另一个网络验证拒绝。 [容器回读与适配器检查](https://github.com/MaLaNg116/itervane/blob/a994e216d1ffeabc473d3ab3b85aeeef59a4f5e9/packages/verification/src/native/komodo-probe.ts#L170)
3. 四组托管 Runner 中的 OCI 场景复用该网络夹具，继续核对两条真实 Komodo 回读路径。结束时按标记移除容器、核对网络归属，再清理网络和 Compose 服务。 [清理与 Runner 接线](https://github.com/MaLaNg116/itervane/blob/a994e216d1ffeabc473d3ab3b85aeeef59a4f5e9/packages/verification/src/native/komodo-probe.ts#L323)

本机 TypeScript 检查和 202 项单元测试通过。七项原生 Komodo 和四组托管 KVM 通过。原生检查记录正确网络通过、运行镜像与恢复核验、临时网络清理。KVM 的实际崩溃重领和 OCI 发布回读与原生 Komodo 报告具有相同源码指纹 `7d34138377487cfd91da724c972e6f56fce6967d30fdca0576ac18a2f485b8a2`。 [原生 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/44954519447) · [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44954519483)

同一任务从 MCP 发起到受保护 HTTPS 入口访问的验收安排在 D2/D3。

合入前复核了 Docker 网络归属、实际容器无宿主端口、适配器拒绝错误网络和隔离资源清理。最终审查版本 `c703a28a78ac511d1d174bc209bc4ba99ce7d46b` 与原生验证代码一致，六项常规检查均通过，已合入 `fbc292002a2114a72aba817ce50ae4e9e41335c6`。 [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44956876012) · [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44956872320)
