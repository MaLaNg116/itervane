# P1-D3-B 固定源码快照与客体离线扫描

基于 `f132dfe` 和 D3-A 已实测的 Git 通道。用本项目公开仓库中固定的维护者样例提交，在同一临时 KVM 客体贯通 Git 获取、源码快照和真实 Gitleaks／Trivy 扫描。 [D3-A 导读](../reviews/p1-d3-source-acquisition.md) · [P1-D 计划](p1-d-isolated-source-inspection.md)

| 单元 | 实现 | 验收 |
| --- | --- | --- |
| B1 样例与快照 | 固定一个含合成密钥模式和 npm 锁文件对照的 Git 提交。出口关闭后，用 Git 对象读取及 D1 校验器重建 commit／tree 和内容清单。配对快照只包含已验证的普通文件，npm 视图只包含其中的 package-lock。 | 比对独立计算的 Git 对象和清单摘要。拒绝越界名、非普通文件、大小越界与对象不一致。使用对象字节，跳过 checkout、依赖安装与项目命令。 |
| B2 摄取与执行 | 在可信外部准备环节核对冻结扫描器资产和实际 Trivy 库，封入可信镜像。扫描服务使用独立身份、只读快照和配置、独立输出目录及禁用 IP socket 的环境。沿用 D1 扫描配置、命令和结果归一化。 | 核验实际挂载与网络限制。一轮中复核 Gitleaks 合成模式及 Trivy 已知漏洞的修复前后对照，另验证缺库不能给出完成结果。项目忽略文件和注释不能关闭检查。 |
| B3 证据 | 回执绑定域 UUID、提交、tree、快照哈希、工具／配置与实际数据库指纹。日志和双语报告只输出边界、结果摘要和受限诊断。 | 取证仅在独立清理成功后标为通过。分支、PR 与主线复跑，保留 Review Guide 和固定代码链接。 |

Gitleaks 本批覆盖快照密钥模式。Trivy 本批覆盖 npm 锁文件漏洞，修复版只对照选定漏洞。Semgrep 与更多代码规则还需后续接入和验收。D3-C 负责把固定计划、领域授权、租约、取消、证据持久化与恢复接进正式 Worker。部署、运维与真实任务的 Runner 闸门继续关闭。

参考 [Git 批量对象读取](https://git-scm.com/docs/git-cat-file)、[systemd 执行隔离](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) 和 [Trivy 离线配置](https://trivy.dev/latest/docs/advanced/air-gap/)。
