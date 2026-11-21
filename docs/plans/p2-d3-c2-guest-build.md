# P2-D3-C2-B · 固定候选的客体离线构建

以合入 #27 的 `1c242bf` 为基线。把真实复扫、按摘要封存的构建 profile 和标准应用编译接入同一个合格 VM。构建证据交给后续受保护 HTTP 检查及 OCI 镜像阶段。 [受保护执行计划](p2-d3-c2-protected-execution.md) · [蓝图 v6](../blueprint-v6.md)

## 授权与材料

- 在已冻结复验输入中加入可选的构建 profile 摘要。Runner 在当前资格开关、同一镜像和有效租约下接受该范围。旧的复扫请求继续返回原有回执。声明构建的请求必须带有同源、同代次、同候选的构建结果。
- 从独立复扫完成的原稿或已重放候选提取标准构建所需的根清单、锁文件、入口、`src/` 和 `server/`。投影摘要随回执保存。维护者提前封存依赖输入、Node/npm、Vite 配方与基线程序。候选包清单或锁文件与已封存缓存不匹配时返回有明确原因的阻断结果。
- 取源身份封存只读输入后触发构建。构建使用独立非 root 身份、私有文件目录、关闭 IP socket、限时与资源限制。安装使用离线缓存副本和固定参数，关闭 lifecycle 脚本。Vite 使用维护者配方，禁用项目环境文件与项目 CSS 配置。 [npm ci](https://docs.npmjs.com/cli/commands/npm-ci/) · [Vite 环境目录](https://vite.dev/config/shared-options#envdir)
- systemd 停止构建进程后，由独立受信任步骤收集核验后的输出清单。构建身份无法写入回执目录。回执只包含固定状态、摘要、文件数和字节数。外部接收仍需核对 Worker 当前执行权、固定输入与真实 VM 清理。 [systemd 的退出状态](https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html#ExecStopPost=)

## 分项开发与验收

| 批次 | 交付 | 验收 |
| --- | --- | --- |
| B1 | 封存 profile、固定构建范围和回执契约 | 缓存投影受限。命令、profile、基线以及源码摘要错误无法提交有效回执。已有复扫记录可读取。 |
| B2 | 隔离客体的构建身份与回执写入 | 合格客体内完成离线 npm 安装和实际 Vite 编译。固定源码与输出摘要可核对。保留隔离检查、依赖缺失、配置不匹配及清理的结果。 |
| B3 | 原生验收、PostgreSQL 回归和审查导读 | 确认真实 Runner、固定 Git 来源、执行权和回执链。以原稿及变更后的锁文件做正式边界核验。用受控缺包对照确认离线安装失败。 |

C2-C 接续应用进程、HTTP 基线证据和停止流程。C3 接续 OCI 制品和同摘要扫描。P2-D3-D 把完整证据交给复验 Agent，发布继续由 P2-E 验收。
