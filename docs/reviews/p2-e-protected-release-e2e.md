# P2-E-D3-D1 · 受保护发布目标的原生验收导读

依赖 [门户与 MCP 双语发布结果 #59](https://github.com/MaLaNg116/itervane/pull/59)。固定代码版本 `a994e216d1ffeabc473d3ab3b85aeeef59a4f5e9`。 [本批计划](../plans/p2-e-protected-release-e2e.md)

1. 原生 Komodo 夹具为每个目标创建带唯一归属标记的 Docker 内部桥接网络。登记目标前按 Docker ID 核对名称、驱动、内部模式和标签。 [网络创建与核对](https://github.com/MaLaNg116/itervane/blob/a994e216d1ffeabc473d3ab3b85aeeef59a4f5e9/packages/verification/src/native/komodo-probe.ts#L52)
2. Komodo 更新结束后，读取实际容器的镜像摘要和网络绑定，要求容器只加入登记网络、没有宿主机端口映射，也未启用特权模式。正式适配器用正确网络读取运行证据，用另一个网络验证拒绝。 [容器回读与适配器检查](https://github.com/MaLaNg116/itervane/blob/a994e216d1ffeabc473d3ab3b85aeeef59a4f5e9/packages/verification/src/native/komodo-probe.ts#L170)
3. 四组托管 Runner 中的 OCI 场景复用该网络夹具，继续核对两条真实 Komodo 回读路径。结束时按标记移除容器、核对网络归属，再清理网络和 Compose 服务。 [清理与 Runner 接线](https://github.com/MaLaNg116/itervane/blob/a994e216d1ffeabc473d3ab3b85aeeef59a4f5e9/packages/verification/src/native/komodo-probe.ts#L323)

本机 TypeScript 检查和 202 项单元测试通过。原生 Komodo 与四组托管 KVM 待验。同一任务从 MCP 发起到受保护 HTTPS 入口访问的验收安排在 D2/D3。
