# P1-D2 Review Guide：一次性 KVM 客体原生复跑

- 基线是 `60114ec`。固定交付代码为 `787d37e76b849c1b74b4981c7960c3aa00236404`，第一轮完整原生证据来自 `bfed5d521a9ea14f108b7b86070bb04e533498fe`。随后统一了 TypeScript 的非 Linux 回执类型。
- 本批补齐了 D2-A 在真实 KVM 上的生命周期、可信客体内的设备检查和重建证据。依赖 [D2-A 探针](p1-d2-libvirt-lifecycle.md)、[本批计划](../plans/p1-d2-runner-native.md) 和 [运行闸门](../decisions/0001-development-and-runtime-gates.md)。

## 1. 阅读顺序

1. 宿主预检打开字符设备，要求 KVM API 12，实际调用 `KVM_CREATE_VM` 并关闭空 VM 描述符。设备缺失、访问权限和 ioctl 失败分别记录。这一回执证明宿主能力，后续另跑客体。 [KVM 入口](https://github.com/MaLaNg116/itervane/blob/787d37e76b849c1b74b4981c7960c3aa00236404/packages/runner/host/kvm_preflight.py) · [内核接口](https://docs.kernel.org/virt/kvm/api.html)
2. 可信客体固定 Canonical 的 Ubuntu Noble 20261017、QEMU Guest Agent 与 liburing 资产。三份输入按 SHA-256 验证，镜像编辑使用断网 libguestfs，之后转 raw 并封存本轮摘要。Cloud-init、SSH 及网络等待单元无启动需求，客体 QGA 只允许心跳、同步和能力读取。 [镜像配方](https://github.com/MaLaNg116/itervane/blob/787d37e76b849c1b74b4981c7960c3aa00236404/fixtures/runner/prepare-probe-image.sh) · [客体配置](https://github.com/MaLaNg116/itervane/blob/787d37e76b849c1b74b4981c7960c3aa00236404/fixtures/runner/configure-probe-guest.sh) · [Canonical 基底](https://cloud-images.ubuntu.com/releases/noble/release-20261017/)
3. 域处于暂停状态时核对实际配置，才允许恢复。libvirt 会添加 q35 芯片组的 iTCO 看门狗，本批限定其模型、数量和动作，并核对重启、关机和崩溃均销毁域。配置差异只返回校验类别，不返回宿主路径或原始 XML。 [宿主检查](https://github.com/MaLaNg116/itervane/blob/787d37e76b849c1b74b4981c7960c3aa00236404/packages/runner/host/libvirt_probe.py) · [libvirt 10.0.0 规范化实现](https://github.com/libvirt/libvirt/blob/v10.0.0/src/qemu/qemu_domain.c)
4. 镜像从只读基底复制给临时域。QGA 服务在实际客体核对 2 个在线 CPU、可见内存范围、virtio 磁盘大小、只有 loopback 后，才在本轮磁盘写入持久标记并启动。重新从同一基底启动，标记必须再次缺席。每轮用独立连接核对域消失并清掉磁盘。错误摘要必须被拒绝，最后确认暂存目录为空。 [客体自检](https://github.com/MaLaNg116/itervane/blob/787d37e76b849c1b74b4981c7960c3aa00236404/fixtures/runner/configure-probe-guest.sh) · [真实启动与负例](https://github.com/MaLaNg116/itervane/blob/787d37e76b849c1b74b4981c7960c3aa00236404/.github/workflows/native-runner.yml)

## 2. 实测

[Native Runner 44719921676](https://github.com/MaLaNg116/itervane/actions/runs/44719921676) 使用 GitHub 托管 Linux x86-64、内核 7.0.0-1014-aws、libvirt 10.0.0-2ubuntu8.19、QEMU 8.2.2+ds-0ubuntu1.18。报告源码指纹为 `4473c7a0cedb0b21f1bce29058bc2273dc9f24886bab98d82f069c2727e2c5b3`。本轮客体 raw 镜像为 3,758,096,384 字节，SHA-256 为 `a795b4ad4df7f7e6d1e33f8c9972c14214c76e6cab628786cc010077a0a66bac`。

| 场景 | 结果 |
| --- | --- |
| KVM 预检 | API 12，实际创建并关闭 VM 描述符。 |
| 英文首轮 | 域 `78273ae9-c7e4-4274-9422-d540efe7bc03` 通过暂停核对、心跳和销毁。 |
| 中文重复轮 | 域 `d60220b3-61a5-4111-b88b-437b0130ab74` 通过同样检查，重建磁盘未继承首轮的客体标记。 |
| 错误摘要负例 | 退出码 1，`runner-image-rejected`，本轮没有进入域创建，暂存目录最终为空。 |
| 本地回归 | 严格类型、102 项 TS/Node 单元及 10 项 Python 流程用例通过。WSL 非特权预检返回 `permission_denied`。 |

工作流归档 `kvm-host-evidence` 中的宿主元数据、镜像来源、两次真实回执和一个负例。可在 GitHub Actions 选择 `Native Runner` 重跑。报告命名区分首轮、重复轮和拒绝负例。只有 `kvm-host.json` 时，按宿主观测码判断是否具备 KVM 条件。

## 3. 下一道验收闸门

本批实证覆盖可信客体、无外接网卡、资源配置、反复启动后的磁盘隔离和清理。实际客体作业协议、真实取消及独立超时、宿主与网络隔离的完整负例、D3 正式固定源码与扫描接入仍需验证。托管探针结果不会授予真实项目执行资格。
