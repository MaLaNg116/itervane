# P5-C3 · 可复现源码发布导读

从固定 commit 生成 v0.1.0 源码归档、依赖许可证、发布清单和总校验文件。从归档独立安装参考控制面并验收双语登录与 MCP。 [本批计划](../plans/p5-source-release.md) · [前置 #171](https://github.com/MaLaNg116/itervane/pull/171)

1. `4dbbaed` 读取固定 Git commit 和代码树，核对工作区状态并记录锁文件摘要。源码归档由 Git 对象生成。索引收集安装包的名称、版本和声明许可证，校验值绑定每个发布文件。来源清单记录打包平台、Node 与 pnpm 版本。 [打包入口](https://github.com/MaLaNg116/itervane/blob/4dbbaed/scripts/package-source-release.ts)
2. `66e2f81` 使用 Ubuntu 24.04、Node 24.14.0、pnpm 11.9.0 连续打包，比较逐文件字节并校验摘要。新目录解包后重装冻结依赖、构建门户，以真实 PostgreSQL、Keycloak、Chrome 和外部 MCP 保存绑定该源码树与归档 SHA-256 的安装摘要。 [托管流程](https://github.com/MaLaNg116/itervane/blob/66e2f81/.github/workflows/source-release.yml)
3. `f215e15` 保存双语下载、验证和重建步骤，以及模型、扫描器、依赖、镜像和规则的版本与许可证来源。各第三方组件按原条款由部署者安装，门户构建保留通知。 [发布操作](../source-release.md) · [组件清单](../release-components.md)

在 `f215e15` 上，同机两次打包的四个文件字节一致。Windows x86-64 实装许可索引包含 281 个包版本，源码归档为 2,429,569 字节，SHA-256 为 `ea91d71d63e47cdda1c8a6cd0547c6c8613642d9cc7d35f06e7576e6aa8bb86b`。从独立解包目录冻结安装、构建门户、登录真实 Keycloak 并以外部 MCP 读回任务均通过。静态类型、287 项单测、工作流 YAML 和三个 Bash 脚本段已检查。正式归档使用通过所有发布判据的合入版本。
