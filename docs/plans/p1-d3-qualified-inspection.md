# P1-D3-C 正式 Runner 资格、执行权与扫描证据

基线为 `c36037e`。D3-B 已实测固定只读快照和离线 Gitleaks／Trivy。D3-C 将同一运行路径接入任务领域，并为重领和取消保留可核对的实际状态。 [D3-B 导读](../reviews/p1-d3-offline-inspection.md) · [P1-D 总计划](p1-d-isolated-source-inspection.md)

| 批次 | 工作 | 验收 |
| --- | --- | --- |
| C1.1 通用检查回执 | 客体使用受控来源、完整 Git 提交和本次仓库标识重建快照。复用受保护扫描策略，返回受限归一化结果、实际数据库信息、快照和策略指纹。 | 已有维护者复跑仍通过。正式回执验证两个扫描状态、实际来源和回收结果，缺库和不支持须显式报告。 |
| C1.2 独立本机控制器 | 仅通过文件系统 Unix socket 接入指定低权限 Worker UID。独立核验登记来源白名单、可信镜像摘要、会话、资源和有效心跳。只允许结构化检查请求，连接断开或心跳停止时终止当前作业。 | 在真实 KVM 用不同 Unix 账户提交固定检查，验证请求绑定、权限拒绝、进程丢失后的停止和回收。根身份、未登记来源和不确定回收继续阻断。 |
| C2.1 正式 Worker 与持久化 | 入口沿用现有 `source.inspect` 和数据库锁。启动前读取当前授权、仓库登记、固定计划及租约，运行中只发送经数据库核验的心跳。回执按任务、项目、run、fence、代次和计划校验，事务内发布经过脱敏的证据。 | 真实 PostgreSQL 验证取消、撤权、失效 fence、重复调用、恢复与证据发布原子性，真实 Worker 联通本机 Runner 和 KVM。 |
| C2.2 状态与复跑 | API、MCP 和双语门户读取同一授权后的检查事实。恢复按前一执行的回收状态决定是否可重试，结果未知保持核对，发布、运维和普通命令各自受原有闸门约束。 | 真实读取端一致，两个 Worker 只有当前执行者可发布。最终主线复跑与 Review Guide 能定位运行证据、代码和支持限制。 |

初期运行范围为维护者显式登记的公开 HTTPS Git 源、完整 SHA-1 提交、现有一次性 VM 和已验证的 Gitleaks／Trivy 配置。Semgrep 和更广工具覆盖继续按 P1 和 P4 的验收安排推进。C1 的控制器验证与 C2 的正式 Worker 准入均需分别留证。

参考 [Linux Unix socket 凭据与权限](https://man7.org/linux/man-pages/man7/unix.7.html) 和 [libvirt 域生命周期契约](https://libvirt.org/html/libvirt-libvirt-domain.html)。
