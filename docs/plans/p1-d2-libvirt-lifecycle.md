# P1-D2-A 一次性 VM 生命周期探针计划

- 基线为 P2-C 合入后的 main `55c9897`。
- 依据为 v6 第 15–18 节、[分阶段实施计划](../implementation-plan-v2-ts-postgresql.md)、[D2/D3 总体计划](p1-d-isolated-source-inspection.md)和 [ADR 0004](../decisions/0004-isolated-source-inspection.md)。
- 当前 WSL 与已检查的云机没有可用的 KVM 设备。本批交付原生宿主端实现和可复跑探针，真实宿主证据仍待验。

## 1. 范围与阶段依赖

| 单元 | 交付 | 验收条件 |
| --- | --- | --- |
| D2-A.1 | 维护者在 Linux x86-64 宿主发起固定的本机 libvirt 探针。验证 KVM、固定摘要 raw 镜像、虚拟机资源和设备配置，然后执行一次固定的 QEMU guest agent 心跳。 | 无 KVM、镜像无效、实际配置不合要求时明确阻断。未确认匹配的虚拟机始终停在启动暂停状态。 |
| D2-A.2 | 一次性虚拟机、独立时限及清理。仅在核对域身份和消失后删除本次磁盘。 | 覆盖启动、验证失败、取消和销毁。结果不明时保留现场并阻止同一目录再次启动。 |
| D2-A.3 | 双语 CLI、脱敏结果、宿主测试及固定版本导读。 | KVM 未提供时非零退出，自动测试证明调用和失败逻辑。真实通过还须运行原生探针。 |

D2-A 是 D2 的首批。D2 仍需任务协议、真实网络与宿主/跨任务隔离、进程树和资源限制证据。D3 依赖完整 D2，负责固定提交获取、扫描和带执行权的产物发布。P2 正式 Agent 和 Komodo 发布继续依赖这些证据。

## 2. 执行边界

协议固定为 `qemu:///system`、KVM、q35、2 vCPU、2 GiB 内存和最多 8 GiB 的独立 raw 磁盘。宿主运维人员提供受信任镜像和 SHA-256，调用仅限本机维护者 CLI。镜像预装 QEMU guest agent，虚拟机仅接入其本地心跳通道。通过 Ubuntu 系统包提供的 libvirt Python 绑定持有临时域的连接，控制面和业务契约沿用 TypeScript。

启动前分配独立名称和 UUID。保持连接直至销毁，使用 libvirt 的断连销毁机制。暂停期间检查实际域配置，清理时重新建立连接核对域不存在。取消或超时后保留不确定的运行目录供维护者核对。报告只记录固定结果码、探针身份和可验证的摘要。

验收使用自动化宿主状态测试、TypeScript 回归及真实 Linux KVM 复跑。API、Worker、外部 MCP 和门户保留既有行为与执行闸门。探针无需仓库 URL、项目凭证、容器 socket、任意命令或授权请求。

参考 [libvirt 域 API](https://libvirt.org/html/libvirt-libvirt-domain.html#virDomainCreateXML)、[域配置](https://libvirt.org/formatdomain.html)、[QEMU Guest Agent 心跳](https://www.qemu.org/docs/master/interop/qemu-ga-ref.html#command-guest-ping)。
