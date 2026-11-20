# P1-D2-B Review Guide：隔离客体作业与停止清理

- 基线为 `97ea680`，固定实现为 `6421319f9c38464b32247bb906a8adca7ab21bca`。本批依赖 [D2-A 原生启动证据](p1-d2-runner-native.md)，交付见 [PR #16](https://github.com/MaLaNg116/itervane/pull/16) 和 [实施计划](../plans/p1-d2-guest-job.md)。
- 作业是一次性的输入摘要核验。驱动只发送本地生成的合成数据。该通道供维护者验证，接入正式 Worker 前继续走 D2/D3 验收。

## 阅读顺序

1. `serve_job` 等到宿主打开通道后发出版本握手。固定请求帧绑定域 UUID、输入长度和 SHA-256。客体先读取最多 64 KiB，回执首块摘要，再流式处理剩余数据。整个输入最多 32 MiB，回执只有固定字段。 [客体协议](https://github.com/MaLaNg116/itervane/blob/6421319f9c38464b32247bb906a8adca7ab21bca/packages/runner/host/guest_job.py#L55) · [协议正反例](https://github.com/MaLaNg116/itervane/blob/6421319f9c38464b32247bb906a8adca7ab21bca/packages/runner/host/test_guest_job.py)
2. `run_guest` 从可信 raw 镜像复制本轮磁盘，以暂停状态启动临时域。作业模式允许额外一个固定名称的本机 Unix 通道，须与 QGA 通道使用不同的 socket，并随域销毁。客体服务只在匹配设备上启动，使用单独的非 root 账户和设备权限，限制内存、进程、网络及文件系统写入。 [暂停校验](https://github.com/MaLaNg116/itervane/blob/6421319f9c38464b32247bb906a8adca7ab21bca/packages/runner/host/libvirt_probe.py#L130) · [客体服务配置](https://github.com/MaLaNg116/itervane/blob/6421319f9c38464b32247bb906a8adca7ab21bca/fixtures/runner/configure-probe-guest.sh#L7)
3. `ProbeJob` 使用 libvirt 非阻塞流，核对握手、域 UUID、字节数、首块和完整摘要。验收驱动在取消和超时场景只发送首块，保留余下数据。取消由父进程在首块回执后发送 SIGTERM。超时场景在首块之后设定 3 秒测试时限，普通作业通道时限为 30 秒，外层保留 180 秒生命周期时限。 [事件循环与作业](https://github.com/MaLaNg116/itervane/blob/6421319f9c38464b32247bb906a8adca7ab21bca/packages/runner/host/native_job.py#L40) · [取消桥接与双语回执](https://github.com/MaLaNg116/itervane/blob/6421319f9c38464b32247bb906a8adca7ab21bca/packages/verification/src/runner-vm.ts#L79)
4. 域销毁后，宿主用独立 libvirt 连接查域名称和 UUID，再移除工作磁盘及 journal。CI 每轮验证暂存目录为空。确认不了时保留运行记录并阻断下一轮。作业完整回执与确认清理分别校验，原始输入和宿主路径不进入报告。 [清理路径](https://github.com/MaLaNg116/itervane/blob/6421319f9c38464b32247bb906a8adca7ab21bca/packages/runner/host/libvirt_probe.py#L324) · [严格回执校验](https://github.com/MaLaNg116/itervane/blob/6421319f9c38464b32247bb906a8adca7ab21bca/packages/verification/src/runner-vm.ts#L54)

## 实测与复跑

[Native Runner 44724749497](https://github.com/MaLaNg116/itervane/actions/runs/44724749497) 使用 GitHub 托管 Ubuntu 24.04、KVM API 12、libvirt 10.0.0-2ubuntu8.19、QEMU 8.2.2+ds-0ubuntu1.18。证据源码指纹为 `18a016a45a5c93a5e5aff98195d2873e893655f7af120957f19fedb7117f4ff0`。本轮镜像为 3,758,096,384 字节，摘要为 `b5340e33914ec698a6b3eefbb779ef9b31034fcb456a0dca06041ca76aa5a074`。

| 场景 | 原生结果 | 清理 |
| --- | --- | --- |
| 英文作业 | 客体先回执 64 KiB，再核验完整 1 MiB，回执与宿主摘要一致 | 独立核对域消失，工作磁盘与 journal 移除 |
| 中文摘要拒绝 | 末尾一个字节变动，客体返回不同摘要和拒绝结果 | 同上 |
| 英文取消 | 客体确认首块后，父进程实际发送 SIGTERM，原生驱动回执取消 | 同上 |
| 中文超时 | 客体已确认首块，等待余下数据时触发宿主作业时限 | 同上 |
| 心跳与镜像回归 | 两轮心跳和干净磁盘通过，错误镜像摘要在启动前拒绝 | 六个实际域标识各不相同，暂存目录为空 |

首次 [原生尝试 44723460186](https://github.com/MaLaNg116/itervane/actions/runs/44723460186) 在首块确认前超时，销毁与清理通过。后续在连接前注册并运行 libvirt 事件循环，使用客体握手确认通道可用。libvirt 的非阻塞读取从异步接收队列取数据。 [libvirt 事件注册](https://libvirt.org/html/libvirt-libvirt-event.html#virEventRegisterDefaultImpl) · [10.0.0 接收实现](https://github.com/libvirt/libvirt/blob/v10.0.0/src/rpc/virnetclientstream.c#L469)

可在 GitHub Actions 中运行 `Native Runner`，在 `kvm-host-evidence` 中核对 `runner-vm-job*.json`、镜像摘要与 KVM 记录。普通本地回归使用 `pnpm check` 和 Linux 的 `python3 -B -m unittest discover -s packages/runner/host`，本批分别通过 103 项 TypeScript 单元和 19 项 Python 用例。[固定实现的常规 CI](https://github.com/MaLaNg116/itervane/actions/runs/44724749479) 的数据库、门户和扫描器均通过。

## 后续验收

本批证明固定作业在实际客体中完成，以及在收取输入期间取消或超时后可以清理整个 VM。完整 D2 仍需专用运行身份、宿主/跨任务访问限制和受限工作负载的验证。D3 负责登记 Git 源、固定快照、真实扫描及绑定任务执行权的产物发布。正式项目执行仍受既有闸门控制。
