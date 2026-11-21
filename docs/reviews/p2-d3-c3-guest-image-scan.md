# P2-D3-C3-B · 客体 OCI 镜像和同摘要扫描 Review Guide

本批依赖 [OCI 输入 #30](https://github.com/MaLaNg116/itervane/pull/30)。首次托管验收的运行代码为 `14e41244821d0943b56d6a6b0388a2377a622276`。 [本批计划](../plans/p2-d3-c3-guest-image-scan.md)

1. `331562b` 让冻结复验显式绑定 OCI 输入。控制器要求额外执行资格，只有已通过基线并确认应用退出的申请可带有镜像回执。镜像与扫描各自的 manifest、config、运行输入和漏洞库须相符。 [复验契约](../../packages/contracts/src/qualified-standard-image.ts) · [控制器](../../packages/runner/host/qualified_controller.py)
2. `c67659e` 确认复验所见的 dist、后端和 Node 摘要。受保护准备程序封装运行文件，独立客体身份用封存的 umoci 创建两层镜像。受限目录、普通文件和确定性元数据约束候选输入。 [封装逻辑](../../packages/runner/host/oci_guest.py) · [客体服务](../../fixtures/runner/configure-probe-guest.sh)
3. `902f755` 复用封存的扫描器和漏洞库，使用 manifest digest 选择 Trivy 的 OCI 输入，核对工具实际读取的 config 与两类包覆盖，保存有界的发现。 [镜像扫描](../../packages/runner/src/guest-image-scan.ts)
4. `8c788cd` 将作用域、同一候选和扫描摘要纳入 PostgreSQL 回执约束。测试冻结摘要被替换及扫描指向另一个镜像时的事务拒绝。 [迁移](../../packages/control-plane/migrations/0023_formal_standard_image_evidence.sql)
5. `14e4124` 在托管 KVM 增加标准镜像场景，核对健康候选的 OCI 证据、503 失败、锁漂移和租约回执重读。 [验收工作流](../../.github/workflows/native-runner.yml)

Windows TypeScript、59 项 Linux 宿主测试、真实 PostgreSQL 全量 120 项通过。首轮 [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44897356042) 使用提交 `cc4b61529a345bf2af58c628f625d15497fb26f8`。C3-C 负责实际 OCI 字节的受限导出和持久交接，后续验收继续走 D3-D 与 P2-E。
