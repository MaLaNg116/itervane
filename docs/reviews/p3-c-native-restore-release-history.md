# P3-C2d4c1 · 同一应用双版本发布导读

本批接续 #114 的恢复审批和回执，固定代码为 `a6ba274ec7ab4a120615943c160dc925b9f3eee8`。 [分批计划](../plans/p3-c-operations-restore.md) · [前置 PR](https://github.com/MaLaNg116/itervane/pull/114)

1. 同一个临时应用共用 Komodo 部署、登记和受保护入口。两份在仓库中可追溯的固定源码各经 Runner、离线复验和镜像扫描。外部 MCP 冻结候选，门户身份确认批准，专用 Worker 读取批准后发布。两次发布都核对原生更新、运行容器和镜像摘要，并比较中英文 HTTP 与 MCP 回执。 [发布与回读](https://github.com/MaLaNg116/itervane/blob/a6ba274ec7ab4a120615943c160dc925b9f3eee8/packages/control-plane/test/native/worker-inspection.ts#L856)
2. 发布 A 后读取当前版本和空历史，再发布不同镜像 B。运维服务按同一个目标登记回读，要求 B 是当前实例、A 是可恢复候选。此处使用正式发布的核验记录确定历史。 [历史检查](https://github.com/MaLaNg116/itervane/blob/a6ba274ec7ab4a120615943c160dc925b9f3eee8/packages/control-plane/test/native/worker-inspection.ts#L934)
3. 主机在两次发布后重新读取 OCI 归档，测量大小、所有者权限、归档与清单摘要。独立托管场景校验版本和原生更新确实变化，持续验证授权健康、匿名拒绝及工作目录清理。 [归档脚本](https://github.com/MaLaNg116/itervane/blob/a6ba274ec7ab4a120615943c160dc925b9f3eee8/fixtures/runner/run-qualified-session.sh#L235) · [托管断言](https://github.com/MaLaNg116/itervane/blob/a6ba274ec7ab4a120615943c160dc925b9f3eee8/.github/workflows/native-runner.yml#L210)

TypeScript、248 项单元、两个 Bash 脚本的语法检查与差异检查通过。实际 KVM 双版本证据以托管任务 `kvm-evidence (protected-release-restore)` 的结果和上传报告为准。C2d4c2 在两次发布的基础上验证故障诊断和指定版本恢复，C2d4c3 验证接管和参考安装。

交付提交 `baaa6844838213af398f38e8354979e4b7f5e15f` 的独立托管任务通过。报告源码指纹为 `ec4af1375aea069adc92afbea5a829e4e84ec55c9eabf29608f81ba40b720225`。A、B 镜像摘要和容器不同，均返回授权 200、匿名 401。回读确认 B 是当前版本、A 是可恢复历史，主机分别保存两份归档核验。 [托管任务](https://github.com/MaLaNg116/itervane/actions/runs/45040417026/job/137263382010) · [报告](https://github.com/MaLaNg116/itervane/actions/runs/45040417026/artifacts/14762060435)
