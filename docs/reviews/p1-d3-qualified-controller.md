# P1-D3-C1 Review Guide · 独立检查控制器

基线为 PR #19 的 `c36037e`，固定实现为 `9c6f32dca118fb7815352ffd6136e5f19ba24f4f`。这一批实现正式检查的本机传输、独立身份和结构化回执。 [PR #20](https://github.com/MaLaNg116/itervane/pull/20) · [D3-C 计划](../plans/p1-d3-qualified-inspection.md) · [D3-B 证据](p1-d3-offline-inspection.md)

## 阅读顺序

1. `qualifiedInspectionRequestSchema` 校验有界检查请求，包含任务、项目、run、仓库、完整提交、代次、fence 和计划摘要。客户端检查 socket 及父目录属主，控制器通过内核提供的 `SO_PEERCRED` 接受唯一指定 UID，并将请求来源和配置中的精确 HTTPS 登记项匹配。 [请求和回执契约](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/packages/contracts/src/qualified-inspection.ts) · [客户端的本机路径校验](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/packages/runner/src/qualified-client.ts#L45) · [服务端身份与来源](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/packages/runner/host/qualified_controller.py)
2. 客户端每次授权通过后发送心跳。控制器收到首个心跳才开始生命周期，独立监听线程在心跳断流、明确停止或连接关闭时撤销作业。源获取继续使用 D3-A 的固定出口，宿主通过已验证的非 root 会话启动没有外接网卡的临时客体。 [心跳和停止](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/packages/runner/host/qualified_controller.py) · [虚拟机生命周期](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/packages/runner/host/libvirt_probe.py)
3. 正式检查通道携带本次仓库 ID，客体用原 Git 字节和 ID 重建清单。实际扫描共享 D3-B 的只读挂载、离线配置和结果归一化。正式回执允许保留明确的扫描失败或不支持状态，包含的发现只有摘要、规则、相对路径、行号和严重级别。 [对象绑定](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/packages/runner/host/native_source.py) · [客体扫描](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/packages/runner/src/guest-inspection.ts#L107)
4. 成功传输前，宿主等待域消失、QEMU 退出和工作磁盘清理。客户端从回执核对原请求作用域、镜像、来源、域和快照，再核对扫描策略及发现摘要。未确认清理的工作区保留阻断状态。 [回执校验](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/packages/runner/src/qualified-client.ts#L62) · [原生用例](https://github.com/MaLaNg116/itervane/blob/9c6f32dca118fb7815352ffd6136e5f19ba24f4f/fixtures/runner/run-qualified-session.sh#L68)

## 托管 KVM 实测

实现版本的源码指纹为 `a0a5ef28d338183b05ad92bc1eb336fe39f8ebd7c8aa4bbf7386dd8b3204ea2f`，原始镜像 SHA-256 为 `81340c55837f4197afe84a032a900a04f12df1ada623579f9655fbf6925b9feb`。下载 `kvm-host-evidence` 后核对 `runner-qualified-*.json` 及原有客体结果。 [Native Runner 实测](https://github.com/MaLaNg116/itervane/actions/runs/44753059024)

| 用例 | 现场结果 |
| --- | --- |
| 客户端与隔离 | 独立低权限客户端不能打开 `/dev/kvm`，经文件系统 Unix socket 提交检查。root、未登记来源和未提供授权心跳的请求均在域创建前拒绝 |
| 真实检查 | 固定 Git 提交 `9167604`，305 个文件，实际返回 Gitleaks 和 Trivy 的归一化结果。请求作用域、域和所用镜像均逐项核对，正式模式的清单使用本轮仓库 ID |
| 停止信号 | 已观察到实际域运行后，验收端停止授权心跳并通知控制器。pidfd 证明原 QEMU 退出，回执绑定同一域并确认清理 |
| 客户端断连 | 已观察到实际域运行后，验收端直接退出。控制器在连接断开后停止客体，独立核对 QEMU 退出、域消失和暂存目录为空 |
| 回归 | 三个控制器域与十一轮既有域的标识互不重复，保留两轮离线扫描、关闭出口、客体隔离、超时和清理验证 |

扫描验收仍用维护者样例，模拟撤去验收调用端的授权。Windows 类型检查和 106 项单元测试通过，Linux CI 通过 107 项 TypeScript 测试、37 项 Runner 测试以及 PostgreSQL、浏览器、扫描器三组验证。 [分支 CI](https://github.com/MaLaNg116/itervane/actions/runs/44753059100) · [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44753069789)

## 复跑与交付边界

`pnpm check` 核对类型和单元测试。Linux 用 `python3 -B -m unittest discover -s packages/runner/host` 验证本机身份、精确来源、心跳过期以及未确认清理时的行为。Native Runner 工作流在临时托管 Ubuntu 上用两个真实账户和一个独立 KVM 会话完成扫描与回收。

C2 使用真实 PostgreSQL 执行权来授权每个心跳，并在同一次受保护事务中记录正式证据。届时 API、MCP 和双语门户读取同一记录。目前平台任务仍等待该准入与恢复路径。

参考 [Unix socket 凭据](https://man7.org/linux/man-pages/man7/unix.7.html) 与 [libvirt 域 API](https://libvirt.org/html/libvirt-libvirt-domain.html)。
