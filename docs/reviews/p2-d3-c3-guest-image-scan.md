# P2-D3-C3-B · 客体 OCI 镜像和同摘要扫描 Review Guide

本批依赖 [OCI 输入 #30](https://github.com/MaLaNg116/itervane/pull/30)。首次托管验收的运行代码为 `14e41244821d0943b56d6a6b0388a2377a622276`。 [本批计划](../plans/p2-d3-c3-guest-image-scan.md)

1. `331562b` 让冻结复验显式绑定 OCI 输入。控制器要求额外执行资格，只有已通过基线并确认应用退出的申请可带有镜像回执。镜像与扫描各自的 manifest、config、运行输入和漏洞库须相符。 [复验契约](../../packages/contracts/src/qualified-standard-image.ts) · [控制器](../../packages/runner/host/qualified_controller.py)
2. `c67659e` 确认复验所见的 dist、后端和 Node 摘要。受保护准备程序封装运行文件，独立客体身份用封存的 umoci 创建两层镜像。受限目录、普通文件和确定性元数据约束候选输入。 [封装逻辑](../../packages/runner/host/oci_guest.py) · [客体服务](../../fixtures/runner/configure-probe-guest.sh)
3. `902f755` 复用封存的扫描器和漏洞库，使用 manifest digest 选择 Trivy 的 OCI 输入，核对工具实际读取的 config 与两类包覆盖，保存有界的发现。 [镜像扫描](../../packages/runner/src/guest-image-scan.ts)
4. `8c788cd` 将作用域、同一候选和扫描摘要纳入 PostgreSQL 回执约束。测试冻结摘要被替换及扫描指向另一个镜像时的事务拒绝。 [迁移](../../packages/control-plane/migrations/0023_formal_standard_image_evidence.sql)
5. `14e4124` 在托管 KVM 增加标准镜像场景，核对健康候选的 OCI 证据、503 失败、锁漂移和租约回执重读。 [验收工作流](../../.github/workflows/native-runner.yml)

Windows TypeScript、59 项 Linux 宿主测试、真实 PostgreSQL 全量 120 项通过。首轮 [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44897356042) 使用提交 `cc4b61529a345bf2af58c628f625d15497fb26f8`。C3-C 负责实际 OCI 字节的受限导出和持久交接，后续验收继续走 D3-D 与 P2-E。

## 同一镜像的实机证据

- 标准健康候选生成 Linux amd64 OCI，Trivy 选择相同 manifest `sha256:62b6c589ef5bb5f4b5f11cb66d0ba245139862fb7bb193cb884c6f4c145bfea0`，实际读取同一 config `sha256:12695aa8c080d17bbbb143ff884ba965d05c2f7e8db13b5e662bae057c6781a9`。
- 扫描识别 92 个 Ubuntu 系统包及 69 个 npm 包，保留 30 项 MEDIUM 与 5 项 LOW 发现。扫描报告 SHA-256 为 `6e14547d3cce7b32d92408566f455c1cfe258ce8f1c2bf43dbbafd7268644d37`，使用与源快照复扫相同的漏洞库 `dba1402419927d3bc4790fbad3eb4309504ee2fb781f431abeebe2ddcce563d9`。
- 标准候选正式回执 `14aeb9cd28d0fe2198bffb98fc145579e0bbe652f608d20b75dc1846ec43e367` 可以从 PostgreSQL 重读。503 对照仍停止在基线阶段，锁漂移返回 `profile_mismatch`。三组场景均已退出并清除工作区。
- 本地从固定提交独立重算源码指纹 `28c577fe1f3f3a41d309a0f061818573dafb6e5589a06ea140b64b6bc1d44bb5`，与托管回执一致。四组原生验收均通过，原稿与两种修复的 VM 清理证据已复核，合入提交为 `18e07fd5327c0a24ccf7886c5ff4338dc8402de3`。实测发现交给正式复验与发布策略判定。
