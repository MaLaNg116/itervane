# P1-D2-C 专用 Runner 身份与客体隔离验收

- 基线为 PR #16 合入后的 `261d668`。参考 [v6 蓝图](../blueprint-v6.md#15-安全隔离与恢复边界)、[P1-D 总体计划](p1-d-isolated-source-inspection.md) 和 [D2-B 原生作业证据](../reviews/p1-d2-guest-job.md)。
- 本批用 GitHub 托管 Linux 的真实 KVM 验证宿主专用身份、guest 作业通道和受限工作负载。延续 D2 的一次性域、脱敏报告和清理闸门。

## 实施顺序

| 单元 | 工作 | 验收 |
| --- | --- | --- |
| C1 | 在专用非 root 用户下使用本机 libvirt session。控制器启用 no-new-privileges，守护进程通过空 capability bounding set 的系统服务单独启动。核对私有目录、可信基底与合成控制面标记。 | 账户对宿主合成标记的实际读取被拒绝。核对暂停域的 QEMU UID、能力集和域标识，并以 pidfd 确认原进程退出。清理复查使用同一个 libvirt 实例。 |
| C2 | 在可信镜像中增加独立的工作负载服务。它核验任务磁盘、系统保护、网络及进程资源限制，并启动一个有界的子进程。 | 只能写本轮工作目录，宿主标记不可见，客体内受保护文件和作业设备读取被拒绝，网络 socket 创建被限制。读取实际 cgroup 的内存与任务数限制，确认子进程已运行。下一轮从可信基底启动时，前一轮工作标记须不存在。 |
| C3 | 用新的客体就绪回执绑定工作负载检查，补充中英文宿主、工作负载及退出回执。复用 D2-B 的真实数据传输和停止场景。 | 旧客体回执不能用于专用身份验收。以中英文实测两次独立作业、数据拒绝、首块之后取消和超时。每次 VM 域及 QEMU 进程退出，暂存目录为空。 |
| C4 | 复查差异、切分提交并归档固定源码和实测。 | 实际 KVM 证据、Python 与 TypeScript 回归、合并后的主线检查都有对应记录和 Review Guide。 |

## 边界

专用身份使用本机 `qemu:///session`，原有维护者生命周期模式仍可作为此前证据的复跑入口。宿主独占运行目录，平台凭证不注入临时 VM。验证使用合成标记和固定脚本，只测显式配置的权限和资源限制。记录固定结果码和可核对的摘要，回执不携带文件内容、权限配置原文或宿主路径。

本批验收覆盖当前无外接网络的固定作业与隔离宿主配置。登记 HTTPS 源与 DNS/出口边界、固定 Git 快照和正式扫描仍在 D3 路径。正式 Worker 接入要满足 D2/D3 和领域执行权检查。

参考 [libvirt 本机实例](https://libvirt.org/drvqemu.html#connections-to-qemu-driver)、[systemd 服务执行限制](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html) 和 [pidfd](https://docs.python.org/3/library/os.html#os.pidfd_open)。
