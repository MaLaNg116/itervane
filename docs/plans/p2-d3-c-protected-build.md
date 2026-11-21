# P2-D3-C · 受保护检查、构建与镜像证据

基于 P2-D3-B 的独立重放与扫描。按 v6 第 8、10、17 节，在合格的一次性 VM 中对同一候选运行维护者基线和针对性检查，再交付可按摘要读取的单一 OCI 镜像。P2-D3-D 将这组证据交给内置复验 Agent，正式发布、目标绑定和人工确认由 P2-E 验收。 [蓝图 v6](../blueprint-v6.md) · [P2-D3 计划](p2-d3-formal-verification.md)

## 受信任输入

- 首批限定标准 React/Vite 与 Node/Express 的独立样例，沿用 `fixtures/standard-app` 的 HTTP 行为、前端资源和无状态运行约定。为固定 Git 样例同时准备 npm lockfile 与 Linux amd64 缓存，复扫及安装共同使用同一清单。
- 复验 profile 将平台测试、检查目录、Node/npm、构建入口、运行基础镜像及镜像扫描配置绑定到内容摘要。缓存由维护者按精确 lockfile 准备并校验 tarball integrity。未命中和不匹配回报具体缺项，执行阶段保持离线。 [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/) · [npm 配置](https://docs.npmjs.com/cli/using-npm/config/)
- 构建账户只能访问源码副本、只读依赖缓存和限额工作区。基线与发布账户保持独立，固定项目参数、子进程和输出路径。将包管理器生命周期脚本关闭，保留隔离的实际 Vite 构建和 Node 应用运行。审计结果解析为固定检查名称、覆盖、状态与摘要。

## 证据与执行边界

- 源码重放或复验产物未经验证时不开始后续步骤。使用现有控制器、当前任务及工作区租约，保留镜像配置、执行权和清理证据。为需要执行项目代码的场景设置独立资格开关。
- 基线用独立的受信任测试验证健康、版本、模拟数据及静态资源，应用只在客体私有回环接受探测。目标问题检查复用复扫的稳定证据。测试源文件独立封存，项目中的同名文件不能修改用例或伪造接受标记。
- 固定运行时配方装入已验证的生产依赖、服务入口和构建产物，限制输出目录的条目、大小、文件类型、路径与权限。优先验证 umoci OCI layout 路径，沿用 P0 的 manifest 与内容摘要核对。Trivy 离线扫描同一只读 layout 引用，扫描前后重新核对 manifest、config 和 layer 关联。 [umoci 层操作](https://github.com/opencontainers/umoci/blob/main/doc/man/umoci-raw-add-layer.1.md) · [OCI layout](https://github.com/opencontainers/image-spec/blob/main/image-layout.md) · [Trivy 容器扫描](https://github.com/aquasecurity/trivy/blob/v0.76.2/docs/guide/target/container_image.md)
- 镜像留存走专门的有界制品通道，对外证据携带摘要、架构和可检索引用。证据接受绑定同一事务所见任务、租约和产物身份。P2-E 将再次从 OCI registry 读取和核对该 digest。失联、超限、验证失败或清理未知均保留具体状态。

## 批次与出口

| 批次 | 交付 | 验收 |
| --- | --- | --- |
| C1 | 标准样例、离线依赖与受保护 profile | 兼容原有标准模板，固定 lock 与缓存。拒绝缓存缺失、替换和不受支持的项目依赖。 |
| C2 | 候选测试、构建与隔离资格 | 限定的标准应用在 KVM 执行安装、构建、受保护测试。固定健康回归和被替换的基线均无法通过。断网、访问边界、超时、取消与清理有原生证据。 |
| C3 | OCI 制品及同 digest 镜像扫描 | 至少一次真实构建的受检制品可按摘要读取，坏 digest、缺 blob、扫描未完成或范围不匹配均阻止候选进入后续阶段。 |
| C4 | 回执验收与代码导读 | 真实 PostgreSQL 和托管 KVM 串联候选快照、测试、构建、扫描和制品记录，保留修复前后与回归结果及下一阶段边界。 |
