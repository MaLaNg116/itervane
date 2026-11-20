# P1-D2-C Review Guide：专用 Runner 身份与客体隔离

- 基线为 `261d668`，固定实现为 `2c51c3880bd9bc32002ca2ba9e506774525c93cb`。依赖 [D2-B 客体作业](p1-d2-guest-job.md)。 [PR #17](https://github.com/MaLaNg116/itervane/pull/17) · [隔离验收计划](../plans/p1-d2-runner-isolation.md)
- 本轮在独立托管机实测固定的全断网工作负载，输入来自维护者生成的合成数据。验证结果服务于 Runner 验收，正式任务需要 D3 的受限源获取、扫描和执行权验证。

## 阅读顺序

1. 宿主用独立非 root 账户运行 `qemu:///session`。工作流清空继承环境后安装锁定依赖，只将 Git 跟踪的源码放入专用目录。libvirt 守护进程由系统服务以专用 UID 启动，capability bounding set 为空。控制器启用 `NoNewPrivileges`。 [宿主准备](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/fixtures/runner/prepare-native-session.sh#L24) · [依赖与源码准备](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/fixtures/runner/run-native-session.sh#L18)
2. `prepare_session` 核对当前真实 UID、补充组、控制器能力集、私有目录、只读基底及合成宿主标记的实际读取拒绝。暂停域再依据本机 session 的 PID 文件、进程域 UUID 和实际能力集核对 QEMU。持有 pidfd 贯穿运行和清理，以便核对的是同一个进程。 [会话预检](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/packages/runner/host/session_boundary.py#L43) · [QEMU 身份](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/packages/runner/host/session_boundary.py#L85) · [域运行与清理](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/packages/runner/host/libvirt_probe.py#L293)
3. 客体作业通道和工作负载使用两个 Linux 账户。工作负载确认宿主合成标记不可见、客体受保护文件和通道设备拒绝读取、系统目录只读以及 IPv4/IPv6 socket 创建被阻断。它在自己的工作目录写入并同步标记，随后启动有界子进程，读取实际 cgroup 的 64 MiB 内存和 4 个任务限额以及 64 KiB 单文件写入上限。 [客体服务配置](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/fixtures/runner/configure-probe-guest.sh) · [实际访问检查](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/fixtures/runner/verify-guest-workload.py#L44) · [实际资源检查](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/fixtures/runner/verify-guest-workload.py#L74)
4. 作业服务等待工作负载就绪，核对固定回执的文件及属主，再返回新版就绪帧。专用会话要求此帧，并在校验本轮首块摘要后记录工作负载证明。根身份、旧握手、无退出证明及不一致的回执均在自动测试中覆盖。 [客体回执](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/packages/runner/host/guest_job.py#L79) · [通道校验](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/packages/runner/host/native_job.py#L66) · [双语报告](https://github.com/MaLaNg116/itervane/blob/2c51c3880bd9bc32002ca2ba9e506774525c93cb/packages/verification/src/runner-vm.ts#L163)

## 实测

[Native Runner 44731986107](https://github.com/MaLaNg116/itervane/actions/runs/44731986107) 使用 GitHub 托管 Ubuntu 24.04、KVM API 12、libvirt 10.0.0-2ubuntu8.19 和 QEMU 8.2.2+ds-0ubuntu1.18。证据源码指纹为 `525f38d5d135d3947224617c0d7f006021470a1b432f9b3b3232bc9587370190`，本轮镜像为 3,758,096,384 字节，原始镜像摘要为 `c550e8af015c2cf3bfc55085e53c27c5beef74b0c9a1ac26f294dcd9777dc579`。

| 场景 | 观察 |
| --- | --- |
| 专用宿主身份 | 真实创建 KVM 描述符。root 身份和错误镜像摘要均在域创建前拒绝。 |
| 第一、第二轮心跳 | 两个独立 KVM 域验证硬件配置、干净磁盘和当前 QEMU 身份后销毁。 |
| 两轮完整作业 | 中英文各完成一次 1 MiB 核验。两轮均成功独占创建并同步本轮工作标记。 |
| 作业拒绝 | 改动末尾字节后，返回不同的完整摘要及拒绝回执。 |
| 取消与超时 | 客体先通过工作负载检查并回执首块，之后分别由真实 SIGTERM 和宿主作业时限结束。 |
| 独立清理 | 七个真实域的标识各不相同。实际 QEMU 进程退出，独立 libvirt 查找确认域消失，每轮暂存目录为空。 |

用于开发的前三次原生尝试分别定位到继承的 pnpm 配置、libvirt QEMU 能力探测和继承 `NoNewPrivileges` 下的执行拒绝。采用空能力集的专用守护进程后，控制器仍启用 `NoNewPrivileges`，客体工作负载仍单独核对该标志。libvirt 使用发行版的执行规则。 [首次准备失败](https://github.com/MaLaNg116/itervane/actions/runs/44729098276) · [QEMU 预检证据](https://github.com/MaLaNg116/itervane/actions/runs/44731390653) · [内核说明](https://docs.kernel.org/userspace-api/no_new_privs.html)

在 GitHub Actions 的 `Native Runner` 查看 `kvm-host-evidence`，核对 `kvm-session-host.json`、`runner-vm-rejected-privileged.json` 和各双语作业回执。本地 `pnpm check` 通过 104 项 TypeScript 单元测试，Linux 的 `python3 -B -m unittest discover -s packages/runner/host` 通过 25 项用例。 [固定实现的常规 CI](https://github.com/MaLaNg116/itervane/actions/runs/44731986195)

## 后续验收

本批使用无外接网络的可信镜像，有界子进程用于证明工作负载已实际运行。D3 需要证明登记 HTTPS 源与 DNS/出口限制，固定 Git 快照、实际扫描、取消和状态恢复均须与领域执行权绑定。该部署宿主和镜像必须按正式工作负载重新核验。
