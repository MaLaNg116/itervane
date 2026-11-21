# P2-E-D3-D3-A · 依赖修复与受保护发布导读

依赖 [同一任务的真实发布 #62](https://github.com/MaLaNg116/itervane/pull/62)。固定代码版本 `0250b8a5507cddb1f57470fd1b7d392d58a85008`。 [分批计划](../plans/p2-e-protected-release-coverage.md)

1. 合成源码固定在 `37ac62431fd9bf7b2a6c0f4b3f15d5d5f1f030b8`，在标准应用的声明和锁文件登记 JSON5 2.2.1。维护者封存的构建选项固定 JSON5 2.2.2 及 npm 制品的 SHA-512 SRI。旧版本只作为待扫描的依赖元数据，隔离构建锁定修复后的完整两文件和缓存。本机已用 Runner 的成对补丁生成器核对两文件字节一致，并读取和校验目标 tarball。 [固定 Git 样例](https://github.com/MaLaNg116/itervane/commit/37ac62431fd9bf7b2a6c0f4b3f15d5d5f1f030b8) · [JSON5 上游修复](https://github.com/json5/json5/blob/main/CHANGELOG.md#v222-code-diff) · [目标版本制品元数据](https://registry.npmjs.org/json5/2.2.2)
2. 模型夹具读取实际 Trivy 报告，引用由已批准公告匹配的两个 Runner 目标。独立复验检查旧发现消失、新发现为零，并核对候选锁文件和清单的指纹与封存构建输入一致。通过后衔接同一套审批、真实 Komodo 和受保护入口。 [依赖修复与复验](https://github.com/MaLaNg116/itervane/blob/dd725a3/packages/control-plane/test/native/worker-inspection.ts)
3. `protected-release-npm` 作为独立托管 KVM 场景留存专用 OCI 和发布证据。核对 HTTP、双语 MCP 与 PostgreSQL 查询的一致性，要求匿名拒绝和所批准的版本真实上线。 [托管场景](https://github.com/MaLaNg116/itervane/blob/074f400/.github/workflows/native-runner.yml)

本机 TypeScript、202 项单元、宿主脚本语法、两文件字节和目标包 SHA-512 校验通过。六组托管 KVM 通过，两类真实发布报告和回归、OCI 报告的源码指纹均为 `28cdf735f497db50ade699459918683bd1b91d309e6f946d65f2c848639143d6`。JSON5 流程在 PostgreSQL 17.12 记录已解决 1 项、新增及残留均为 0。实际发布镜像和复验摘要一致，授权状态 200、匿名 401。两个语言的 HTTP/MCP 结果一致，非门户批准被拒绝，工作区已清理。 [依赖修复托管结果](https://github.com/MaLaNg116/itervane/actions/runs/44958123627/job/137010664625) · [全部托管回归](https://github.com/MaLaNg116/itervane/actions/runs/44958123627)

审批后漂移与操作现场故障由 D3-B/C 覆盖。

合入审查复核了 npm 许可范围、前后依赖清单与归档绑定、应用入口、批准身份和宿主清理。`417999af80ab7270feec8292536e8bae3fbd9be6` 的六项常规检查通过，运行代码与原生证据版本一致，已合入 `c5b247c8eab39b4d707e900e2e2435cd6ecf56ca`。 [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44960785794) · [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44960780746)
