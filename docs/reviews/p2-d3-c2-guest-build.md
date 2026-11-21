# P2-D3-C2-B · 客体离线构建导读

以已合入 #27 的 `1c242bf` 为基线。复验请求按显式资格在同一个一次性 VM 运行复扫后构建，保留固定投影及工作区清理证据。 [实施计划](../plans/p2-d3-c2-guest-build.md)

1. `4db6b55` 把构建 profile 摘要加到冻结输入、受权请求和回执。控制器需要明确启用，主机和客户端都检查返回的任务、候选、基线与运行域。 [资格检查](https://github.com/MaLaNg116/itervane/blob/4db6b55/packages/runner/host/qualified_controller.py) · [回执校验](https://github.com/MaLaNg116/itervane/blob/4db6b55/packages/runner/src/qualified-client.ts)
2. `084c965` 准备固定 npm 工具、缓存、独立基线和 Vite 配方。取源账户在确认复扫回执及匹配覆盖后，只投影标准应用所需路径。维护者批准的清单摘要约束可使用的依赖。 [配方封存](https://github.com/MaLaNg116/itervane/blob/084c965/scripts/prepare-runner-build-dependencies.ts) · [候选投影](https://github.com/MaLaNg116/itervane/blob/084c965/packages/runner/src/guest-standard-build.ts)
3. `14eed3a` 分开构建账户和受保护的回执目录。构建账户在进入包安装前核对挂载、权限、网络和设备边界，在私有目录运行固定 npm/Vite 命令。systemd 结束该服务的进程后，通过受限路径遍历生成有界 dist 指纹。 [客体编排](https://github.com/MaLaNg116/itervane/blob/14eed3a/fixtures/runner/configure-probe-guest.sh) · [构建与回执](https://github.com/MaLaNg116/itervane/blob/14eed3a/packages/runner/host/build_guest.py)
4. `492a7b2` 为构建证据增加 PostgreSQL 约束。构建请求缺证或更换候选及基线时不能保存正式回执。旧的复扫记录仍按原有范围验证。 [迁移](https://github.com/MaLaNg116/itervane/blob/492a7b2/packages/control-plane/migrations/0021_formal_standard_build_evidence.sql) · [真实事务回归](https://github.com/MaLaNg116/itervane/blob/492a7b2/packages/control-plane/test/integration/inspections.test.ts)
5. `e598d45` 把标准应用、锁文件漂移和缓存缺失分别纳入托管原生验收。测试使用真实审计 Worker、有限的固定样例、PostgreSQL 租约和专用宿主账户。以复验回执与宿主域清理核对对应结果。 [验收入口](https://github.com/MaLaNg116/itervane/blob/e598d45/.github/workflows/native-runner.yml) · [版本固定的标准应用](https://github.com/MaLaNg116/itervane/tree/3a719ca44f306d30cdf2d27e9a6d3b954ed656f0) · [锁文件漂移对照](https://github.com/MaLaNg116/itervane/tree/03e5d18a27d23960f040c0d5d70afefac15ec46e)

本地严格类型检查、48 项宿主测试以及 PostgreSQL 构建证据专项通过。标准样例锁文件的真实 Trivy 离线检查无发现。实际安装和构建验收以托管 KVM 产物为依据。

C2-C 接入同一候选上的 HTTP 基线运行和退出清理。C3 绑定最终镜像及其扫描。生产复验 Worker 和真实发布继续由各自阶段验收。 [P2-D3 完整计划](../plans/p2-d3-formal-verification.md)
