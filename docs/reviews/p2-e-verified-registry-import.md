# P2-E-C2 · 同摘要的 Registry 导入与独立回读

基于 [受保护归档传输 #44](https://github.com/MaLaNg116/itervane/pull/44)。 [分批实施计划](../plans/p2-e-formal-release-execution.md)

1. `2ce6bb6` 由 Worker 以非 root 身份运行私有 OCI 布局物化器。输入文件先重算归档字节和摘要。工具逐条读取有限的 tar 成员，只按预期名称创建普通文件。复用既有 OCI 平台、manifest、配置与层验证，拒绝路径逸出、重复、链接和错配。这样避免了 Skopeo 直接读取 OCI tar 时尝试恢复归档属主的问题。 [布局物化](https://github.com/MaLaNg116/itervane/blob/2ce6bb6/packages/runner/host/materialize_oci.py) · [负例](https://github.com/MaLaNg116/itervane/blob/2ce6bb6/packages/runner/host/test_oci_layout.py)
2. `12f89c4` 从可信安装配置读取 Registry 来源，使用登记仓库并按单一 digest 导入。外部进程接收固定参数，凭证临时保存在私有文件，退出后清理。镜像和配置的可见证明来自 Registry 的独立回读，核对摘要标头、原始字节和配置长度。已有同摘要直接复核，拷贝响应丢失时也先读取实际状态。异常且缺少可信证明时停止。 `3454c55` 统一脱敏的配置错误。 [导入适配器](https://github.com/MaLaNg116/itervane/blob/3454c55/packages/control-plane/src/runtime/release-registry.ts)
3. `d0f6338` 托管 OCI 路径在受保护 Runner 回读后从实际审批操作拿到已冻结的归档和目标，从独立的本地 Distribution 验证实际导入。验证错误配置和二次调用，确认相同镜像、配置和来源，并清理临时 Registry。 [原生测试路径](https://github.com/MaLaNg116/itervane/blob/d0f6338/packages/control-plane/test/native/release-archive.ts) · [临时 Registry](https://github.com/MaLaNg116/itervane/blob/d0f6338/packages/control-plane/test/native/registry-fixture.ts)

固定源码 `d0f63387470d4b2a2c86b7f6d36a4d2f5cf4ed16`。TypeScript、163 项单元和 70 项宿主测试通过。非 root 本机试验使用 Skopeo 1.13.3 和经 SHA-256 核对的 Distribution 3.1.2，验证回环与 TLS Basic 两种连接、同摘要复用、写入后拷贝响应失败、授权丢失、错误证据、不正确的凭证和 Registry 数据错配。所有暂存均已清理。该本机试验使用合成 OCI，真实 KVM 镜像和审批操作由托管流程验证。 [Distribution v3.1.2](https://github.com/distribution/distribution/releases/tag/v3.1.2)

固定源码全量 PostgreSQL 138 项通过，源码指纹为 `0a7beac19a1cafce133f33aa6c171e151eb81d121de14557acde594cb7003960`。

C3 将实际 Registry 来源纳入目标版本核对，并把归档交接和导入接入正式执行槽。C4 与 E-D 分别进行 Komodo 派发和实际在线版本核对。 [PR #45](https://github.com/MaLaNg116/itervane/pull/45) · [托管 KVM 与 Registry 验收](https://github.com/MaLaNg116/itervane/actions/runs/44921453641)
