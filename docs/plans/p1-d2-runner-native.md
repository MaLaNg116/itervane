# P1-D2 一次性 Runner 原生验收

- 基线为 `60114ec`，依赖 [D2-A 生命周期探针](p1-d2-libvirt-lifecycle.md)、[隔离与源码检查计划](p1-d-isolated-source-inspection.md) 和 [ADR 0004](../decisions/0004-isolated-source-inspection.md)。
- 本轮用现有 Ubuntu 24.04 x86-64 托管测试机尝试取得真实隔离证据。开发机与用户云机上的现有配置保留。托管工作机、可信镜像及原生探针的结果独立记录。

## 1. 实施单元

| 单元 | 工作 | 验收 |
| --- | --- | --- |
| N1 | 在托管机直接读 KVM 版本并创建空 VM 文件描述符 | 分开记录设备缺失、权限与 ioctl 结果。该检查只创建空内核对象。 |
| N2 | 提供固定来源的可信启动镜像及原生生命周期复跑 | 核对来源和镜像摘要、实际域配置与客体心跳，并核对域和磁盘清理。 |
| N3 | 诊断实际失败或补充隔离证据 | 缺少 KVM 记录为阻断。能启动时核对资源、无外接网络和客体观察范围，以实际证据标注仍待验的任务限制。 |
| N4 | 固化中英文结果、源码和宿主版本及 Review Guide | CI 与源码对应。通过证据仅用于维护者可信探针，继续按 D2/D3 闸门推进正式任务。 |

宿主测试与后续客体作业沿用 KVM/libvirt。采用普通免费托管 runner 做独立证据；不会通过放松隔离、使用容器作为客体或写入正式任务来跳过验收。

参考 [KVM API](https://docs.kernel.org/virt/kvm/api.html)、[libvirt 域创建与临时域](https://libvirt.org/html/libvirt-libvirt-domain.html#virDomainCreateXML)。
