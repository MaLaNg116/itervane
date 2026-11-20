# P1-D3-A Review Guide · 登记 Git 来源获取

- 本批基于 PR #17 的 `a9276df`，固定实现为 `cf9b7e3c828014392fecfb4198993f45be296a79`。一次性 KVM 客体获取本项目已登记的公开仓库和固定提交，为后续只读快照和离线扫描验证真实来源。 [PR #18](https://github.com/MaLaNg116/itervane/pull/18) · [本批计划](../plans/p1-d3-source-acquisition.md) · [D2-C 隔离实证](p1-d2-runner-isolation.md)

## 阅读顺序

1. 从 `maintainer_source` 看本批使用的唯一仓库及完整 commit。探针只接受专用非 root 会话，暂停态核对原始工作磁盘、无外接网卡和两个命名通道。来源场景只附接心跳和 Git 通道，核对 QEMU 进程身份后才恢复客体。 [固定输入](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/runner/host/native_source.py#L116) · [暂停态与清理](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/runner/host/libvirt_probe.py#L294)
2. 跟一次 `SourceGateway.request`。宿主校验登记 HTTPS 主机和路径，每轮解析一次并核对全部 IPv4 地址，之后使用固定地址连接，仍按原主机名验证 TLS。仅转发一次 refs 查询和目标仓库的只读 upload-pack，校验唯一 `want`、固定 commit、深度 1 和允许的结束帧。拒绝重定向，限制请求次数、传输字节和套接字 I/O。 [登记和地址校验](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/runner/host/source_gateway.py#L31) · [固定获取协议](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/runner/host/source_gateway.py#L61) · [请求执行](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/runner/host/source_gateway.py#L125)
3. 客体用独立账户和私有 loopback 启动 Git 2.43.0，在空 bare 仓库中获取固定对象。通道与可写目录归该账户，工作负载身份无法读取设备。Git 在清空继承环境后运行，禁用 hooks、重定向和子模块递归。没有 checkout，也没有运行项目代码。 [客体服务](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/fixtures/runner/configure-probe-guest.sh#L44) · [Git 命令与获取](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/runner/host/source_guest.py#L84)
4. Git 获取进程退出后，宿主关闭来源网关，客体通过同一通道再次请求 refs。关闭检查在发起网络连接之前拒绝该请求。客体随后独立执行 `fsck --strict`，核对 commit、tree 和普通文件记录。回执绑定本轮域 UUID，并只报告对象标识、摘要和计数。成功报告同时要求专用会话和回收证明，CI 将回执与固定提交的预期值比对。 [关闭与回执](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/runner/host/native_source.py#L48) · [客体对象核验](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/runner/host/source_guest.py#L128) · [双语报告与结果检查](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/packages/verification/src/runner-vm.ts#L80) · [CI 对照](https://github.com/MaLaNg116/itervane/blob/cf9b7e3c828014392fecfb4198993f45be296a79/fixtures/runner/run-native-session.sh#L84)

## 实测证据

分支的 Native Runner 在 GitHub 托管 Ubuntu 24.04 实际创建 KVM 域。源码指纹为 `1d108414ed102489f4b5e10ed9f9eccbcb99427c07703a459e2a8481fc78f943`，本轮封存镜像的 SHA-256 为 `97898ccc0f3e1edea29f1bbb4741404e8ea25519374d23d2108244de68373ad7`。 [原生运行及 kvm-host-evidence](https://github.com/MaLaNg116/itervane/actions/runs/44737581998)

| 核对项 | 英文与简体中文两轮实际结果 |
| --- | --- |
| 登记来源 | 本项目公开仓库，来源 SHA-256 `686b1c07b71366c6ff45e6773891ad3dbb3c6c61a03712a3be1e58331853810e` |
| 固定提交与树 | commit `a9276df7269444caeb61724ba490bf0387c4e3aa`，tree `96a3baee0719fad7da783758d15592f1e4dc50b0` |
| 客体独立复核 | 两轮均核验 290 个文件，提交内容 SHA-256 `789539d66651cbceb8b82079830f2559038e52b76ee7823ebdd1d88639e9e056` |
| 获取和关闭 | 每轮完成 3 次请求，分别传输 578407、578422 字节。客体再次请求时得到关闭拒绝。 |
| 独立回收 | 两轮来源验证与七轮既有心跳和作业使用不同的域 UUID，均确认 QEMU 进程退出。根身份和错误镜像摘要在域创建前被拒绝。 |

在下载的证据中核对 `runner-vm-source.json`、`runner-vm-source-repeat.json` 和 `kvm-session-host.json`。本地 TypeScript 类型检查与 105 项单元测试通过，Linux Runner 通过 33 项测试。分支与草稿 PR 的三组 Linux 检查均通过，覆盖真实 PostgreSQL、浏览器和扫描器回归。 [分支 CI](https://github.com/MaLaNg116/itervane/actions/runs/44737581699) · [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44737810805)

## 复跑与验收范围

本地运行 `pnpm check`。Linux 使用 `python3 -B -m unittest discover -s packages/runner/host`，覆盖登记校验、非公开地址拒绝、固定对象请求、关闭后的拒绝、错误回执和不同通道。原生验收由仓库的 Native Runner 工作流在临时 KVM 环境重复，使用固定公开 HTTPS 来源和 SHA-1 格式的 Git 对象。完整源码快照、离线扫描、领域仓库登记及 Worker 执行权发布由后续批次验收，平台任务仍等待 Runner 闸门。

参考 [Git Smart HTTP](https://git-scm.com/docs/http-protocol)、[Git 对象传输协议](https://git-scm.com/docs/gitprotocol-pack) 和 [libvirt 通道](https://libvirt.org/formatdomain.html#channel)。
