# P1-D3-B Review Guide · 固定快照和离线扫描

基线为 PR #18 合入后的 `f132dfe`，固定实现为 `b31097161e06e88faf0b15608d83ffc0d3c46547`。本批在同一临时 KVM 客体连接真实获取、内容清单、只读快照和两种原生扫描器。 [PR #19](https://github.com/MaLaNg116/itervane/pull/19) · [本批计划](../plans/p1-d3-offline-inspection.md) · [D3-A 导读](p1-d3-source-acquisition.md)

## 阅读顺序

1. 从固定样例提交 `9167604` 看原始和修复目录。合成密钥文本和 npm 锁文件仅作为扫描数据。来源网关关闭后，原生控制器先确认源码回执属于本轮域，再等待离线扫描回执。 [样例](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/fixtures/runner/inspection-input) · [隔离来源与回执](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/packages/runner/host/native_source.py)
2. `publishGuestSnapshot` 先从 Git tree 读普通文件记录，再用有界批量读取得原始 commit 和 blob。复用 D1 的内容校验器重建对象图、验证路径和字节上限。只有校验通过才原子发布快照。npm 视图与完整快照中的 package-lock 使用同一文件，读回时重新检查路径、inode、Git 对象和清单。 [快照材料化与复核](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/packages/runner/src/guest-snapshot.ts#L95) · [D1 校验器](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/packages/runner/src/snapshot.ts)
3. 镜像准备在宿主核对固定扫描器下载摘要，用官方 OCI 库准备 Trivy 数据并记录实际 SHA-256 与更新时间。Node、扫描程序、受保护配置和库随可信镜像一起封存。扫描由另一个客体账户执行，启动前实际核对只读挂载、非 root、NoNewPrivileges、IP socket 拒绝和源码通道访问拒绝。 [封存输入](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/scripts/prepare-runner-inspection.ts) · [客体服务](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/fixtures/runner/configure-probe-guest.sh) · [真实边界检查](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/packages/runner/host/scan_guest.py#L16)
4. Gitleaks 扫描完整快照，Trivy 只扫描 npm 锁文件视图。D1 的固定命令和归一化仍负责拒绝不可靠报告。客体对照有无合成密钥、指定 CVE 是否出现在预期清单以及缺库拒绝，扫描后重新核对库和快照指纹。原始输出留在客体私有临时目录，宿主回执只保留哈希、计数与有界状态。 [离线扫描与对照](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/packages/runner/src/guest-inspection.ts#L108) · [双语回执校验](https://github.com/MaLaNg116/itervane/blob/b31097161e06e88faf0b15608d83ffc0d3c46547/packages/verification/src/runner-vm.ts)

## 开发校核

固定样例提交 `9167604c888416d7b6518e1c76485d7308cffb5c` 的 tree 为 `8eef89792444aea73d0aa90b87e552bbfc2d25d9`。Linux 实际快照与独立读取 Git 字节的计算均得到 305 个文件、1844359 字节和清单 SHA-256 `87e87fe4cddfcc6cbb4ed4ed4a2a7644e79a622919fd325f17e8b5841c7b2ca7`。本地 Linux 使用官方扫描器与当前正式漏洞库得到一个 Gitleaks 发现和六个 Trivy 发现，前后对照通过。客体权限和生命周期另由托管 KVM 验收。

首次原生尝试在准备阶段失败，流水线随后保留了失败退出码和脱敏阶段。第二次实测确认官方 Trivy 解包库为 1791803392 字节，超出原先的 1.5 GiB 容量。扫描验证镜像在封存前扩至 6 GiB，遵守 8 GiB 临时磁盘上限。 [首轮准备失败](https://github.com/MaLaNg116/itervane/actions/runs/44743271093) · [容量证据](https://github.com/MaLaNg116/itervane/actions/runs/44743929181)

一次扩容试验重建了分区表，日志显示原根分区由 `sda1` 变为 `sda4`，第一轮心跳随后超时。现有脚本延伸同一 GPT 分区的末端，并比较扩容前后的磁盘 GUID、根分区 GUID、文件系统 UUID 和逻辑扇区。 [启动与分区证据](https://github.com/MaLaNg116/itervane/actions/runs/44744471016) · [libguestfs GPT 与分区扩容](https://libguestfs.org/guestfs.3.html#guestfs_part_expand_gpt)

## 托管 KVM 实测

分支的 Native Runner 在 Ubuntu 24.04 实际运行 11 个互不复用的 KVM 域。源码指纹为 `f974df50252831be42876d810cf5964934b5c78a217bcc0f6723d6193f4fe4e2`。6 GiB 封存 raw 镜像 SHA-256 为 `28c83ef27c58d35dce0f1f8d146464975dfc3f0f1996a10a3d223a903f2716fb`，封存扫描输入 SHA-256 为 `7dd0d9566a082e3efd479d79e356cc3b39bb571dc0b017a9c8089a46f822b407`。 [Native Runner 证据](https://github.com/MaLaNg116/itervane/actions/runs/44746001023)

| 项目 | 英文与简体中文两轮结果 |
| --- | --- |
| Git 与快照 | 固定 commit 和 tree 相同，305 个文件、1844359 字节，清单摘要与独立 Git 校核一致 |
| 只读与离线 | 客体在扫描服务中确认只读挂载，实际拒绝 IPv4、IPv6 和来源通道设备，来源出口关闭的负例通过 |
| Gitleaks 8.30.1 | 1 个发现，原始合成模式被识别，更新后的对照未命中。结果 SHA-256 `ee2b3ad7433543df2dd443882dfa460d82076f9d6f9456007653b8d3a45f3db3` |
| Trivy 0.76.2 | 6 个发现，原始锁文件命中指定 CVE、更新后不再命中该项，缺库执行返回失败。结果 SHA-256 `b5c43e005cb1dbc783155b50178f1f9468c63002eea83bb6969ec8f6f2dd7e59` |
| 官方漏洞库 | SHA-256 `53898b646dc889e0a6449b4c9fd0cb2a88a86493261c4358cbef8e30cb052736`，更新时间 `2026-11-20T13:11:33.075919767Z`，扫描前后一致 |
| 独立回收 | 两轮扫描、两轮获取和七轮既有客体用例均确认真实 QEMU 退出，根身份和错误镜像摘要仍被阻断 |

在 `kvm-host-evidence` 核对 `runner-vm-inspection.json`、`runner-vm-inspection-repeat.json` 和 `kvm-inspection-inputs.json`。普通 CI 完成真实 PostgreSQL、浏览器及扫描器回归。Linux 运行完整 107 项 TypeScript 单元测试和 34 项 Runner 测试。 [分支 CI](https://github.com/MaLaNg116/itervane/actions/runs/44746001027) · [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44746008350)

## 复跑与范围

`pnpm check` 执行类型和单元测试，Linux 额外执行真实 Git 对象发布与错误 npm 投影负例。用 `python3 -B -m unittest discover -s packages/runner/host` 复跑 Runner 约束，托管 KVM 的 Native Runner 工作流执行完整实测和原生清理。

验证输入为本项目公开仓库中的固定样例提交。Gitleaks 本批覆盖密钥模式，Trivy 覆盖 npm 锁文件，修复版仅对照指定漏洞。正式领域授权、执行代次、取消、归一化产物持久化和恢复属于 D3-C，其他扫描器也需单独接入验证。平台真实任务继续等待 Runner 闸门。
