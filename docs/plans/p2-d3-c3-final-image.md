# P2-D3-C3 · 最终 OCI 产物和独立镜像扫描

本批承接 [客体 HTTP 复验 #29](https://github.com/MaLaNg116/itervane/pull/29)，把受保护复验所见的标准应用运行目录固定为同一份可扫描、可核验、可交付的 OCI 镜像。正式发布仍走 P2-E 的人工审批、Komodo 和运行状态核对。 [P2-D3 实施计划](p2-d3-formal-verification.md)

## 输入与运行边界

- 由维护者准备固定的 Ubuntu 24.04 linux/amd64 基础镜像和 umoci 工具。接收时记录上游 manifest、OCI manifest、config 和层摘要。构建 profile 绑定实际封存的工具、基础镜像和独立扫描配置。仓库和模型只能提供候选内容。 [官方基础镜像](https://github.com/docker-library/repo-info/blob/master/repos/ubuntu/remote/noble.md#ubuntunoble---linux-amd64) · [umoci 发布](https://github.com/opencontainers/umoci/releases/tag/v0.6.0)
- 复验先完成同一候选的重放、文件扫描、离线构建和受保护 HTTP 检查。确认应用进程退出后，以经过校验的后端、锁文件、生产依赖、构建产物和封存 Node 运行时组装 OCI 层。应用源码和依赖安装及运行均留在合格的一次性 VM。
- 镜像固定为 Linux amd64、非 root、显式入口和版本。归档限制路径、文件类型、数量和总大小，配置与输出均可由同一运行输入重测。只将所需运行文件加入镜像。
- 独立角色使用同一冻结漏洞库和完整 OCI manifest digest 运行 Trivy。记录系统包和应用依赖覆盖、发现与报告摘要。摘要不匹配、扫描缺证、HTTP 回归或未确认清理均阻止候选成为合格产物。 [Trivy OCI 输入](https://github.com/aquasecurity/trivy/blob/v0.76.2/pkg/fanal/image/oci.go)
- 产物由 Runner 受限通道导出，校验长度和摘要后按内容寻址存储。正式任务、当前执行权、冻结输入和回执共同约束接受与重领。发布之前再次核对同一 digest，保护镜像库及 Komodo 凭证。

## 按依赖交付

| 批次 | 范围 | 验收 |
| --- | --- | --- |
| C3-A | 固定运行基底、封装工具与 OCI 读校验 | 实际取得维护者锁定的镜像及工具，核对 config、层及平台。Blob、引用被替换或文件越界时失败。用 umoci 生成 OCI 试验层并复核同一 manifest。 |
| C3-B | 同一客体组装和离线镜像扫描 | 在合格 VM 针对标准项目产生真实 OCI，并对同一 digest 完成覆盖检查。保留与 HTTP 检查、运行输入和冻结数据库的关联。失败或缺证对照有明确结果。 |
| C3-C | 持久化产物交接 | 核验实际制品的完整字节、内容地址、回执、任务权限与清理状态。取消、过期执行者、破损归档及重复交付均有实测。 |

C3 仍使用标准无状态应用和合成数据。D3-D 接到正式复验 Agent、返修和双语读面，P2-E 通过发布审批和实际版本核对完成开发交付闭环。
