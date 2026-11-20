# P1-D3-A 登记 HTTPS 源与固定 Git 提交验收

- 基线为 PR #17 合入后的 `a9276df`。参考 [v6 蓝图](../blueprint-v6.md)、[P1-D 总体计划](p1-d-isolated-source-inspection.md) 和 [D2-C 原生隔离证据](../reviews/p1-d2-runner-isolation.md)。
- D3 从实际登记源获取开始。维护者验证使用本项目公开仓库及主线完整提交，运行于已经验证的一次性 KVM 会话。扫描和正式领域写入在后续 D3 任务中使用这里的验证结果。

## 实施顺序

| 单元 | 工作 | 验收 |
| --- | --- | --- |
| A1 | 完成只读 Git HTTPS 出口。宿主解析登记源一次，核对解析地址范围，固定连接地址及 TLS 主机名，将方法和路径限定为该仓库的 refs 与 upload-pack。 | 非登记源、非公开解析地址、重定向、参数越界或请求其他提交时拒绝。读写字节、请求数、I/O 及整个获取阶段有明确限额。 |
| A2 | 在一次性客体用独立账户运行 Git。专用通道接到客体的私有 loopback HTTP 服务，再经宿主到已验证的 HTTPS 源。所有 Git 命令、对象解析和完整性检查发生在客体。 | 客体只看到 loopback。只获取完整 commit 的浅层对象，不执行 checkout、hooks、过滤器、子模块或项目代码。断开获取后才验证对象，固定回执包含本轮身份、实际 Git commit 和 tree，限定字段和尺寸。 |
| A3 | 贯通双语验证收集并复跑原有 D2。核对可信镜像、专用进程、实际请求和清理。 | 真实 Git 在 KVM 内得到本项目登记提交及实际 tree。来源中继关闭后的请求被阻断。临时域、QEMU 进程和工作磁盘清理可独立确认。 |
| A4 | Review、分项提交和归档。 | Python 与 TypeScript 检查、真实 KVM 证据、最新 PR 检查和主线结果原样关联至 Review Guide。 |

## D3 的接续边界

本批登记源属于验证驱动，生产端仍需读取正式仓库登记、核对租约及当前授权，并绑定隔离资格。D3 后续将用经过路径与大小验证的只读快照运行固定扫描器，导入经核验的离线规则与漏洞库，发布有界产物并保持执行权与恢复检查。获取支持范围以本批实际的公开 HTTPS 源和受限协议为准。

参考 [Git Smart HTTP](https://git-scm.com/docs/http-protocol)、[Git 对象传输协议](https://git-scm.com/docs/gitprotocol-pack)、[固定 Git 配置](https://git-scm.com/docs/git-config) 和 [libvirt 命名通道](https://libvirt.org/formatdomain.html#channel)。
