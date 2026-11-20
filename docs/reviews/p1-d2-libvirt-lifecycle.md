# P1-D2-A Review Guide：一次性 VM 生命周期探针

- 基线为 `55c9897`（P2-C 已合入）。固定实现为 `95373abb7211fbc06d051b49fb7c368985604cc2`。
- 依赖是既有 D1 源码检查计划和 ADR 0004。验收按 [本批计划](../plans/p1-d2-libvirt-lifecycle.md)和 [运行资格 ADR](../decisions/0001-development-and-runtime-gates.md)执行。

## 1. 从命令到实际虚拟机

1. `pnpm probe:runner-vm` 以本机维护者身份运行。TypeScript 启动固定的系统 Python，传入明确的镜像、摘要和暂存目录，只接受指定格式的回执。子进程环境只传递系统路径和语言设置。 [CLI 启动与回执校验](https://github.com/MaLaNg116/itervane/blob/95373abb7211fbc06d051b49fb7c368985604cc2/packages/verification/src/runner-vm.ts)
2. 宿主驱动要求可用的 Linux x86-64 KVM，检查本机 libvirt 域能力，并为本轮独占目录和临时域标识。复制镜像时重算 SHA-256，限定文件长度、类型和权限。镜像校验失败从未发起 VM 创建。 [原生实现](https://github.com/MaLaNg116/itervane/blob/95373abb7211fbc06d051b49fb7c368985604cc2/packages/runner/host/libvirt_probe.py)
3. libvirt 启动暂停的临时域。核对名称、UUID、临时属性、当前内存、vCPU、唯一 raw 盘和设备后恢复，客体工具只有固定的 `guest-ping`。驱动持有创建域的连接，以利用其断连销毁机制。 [libvirt 域创建](https://libvirt.org/html/libvirt-libvirt-domain.html#virDomainCreateXML) · [QEMU Guest Agent 协议](https://www.qemu.org/docs/master/interop/qemu-ga-ref.html#command-guest-ping)
4. 退出时仅销毁已经确认归属的域。关闭原连接并重新查询名称与 UUID，两项都返回 `VIR_ERR_NO_DOMAIN` 时才清理已发起创建的本轮磁盘。启动应答或清理证据丢失会留下运行目录。下一次在同一暂存目录启动会阻断。 [宿主流程测试](https://github.com/MaLaNg116/itervane/blob/95373abb7211fbc06d051b49fb7c368985604cc2/packages/runner/host/test_libvirt_probe.py)

## 2. 在符合条件的主机上复跑

使用专用的 Linux x86-64 KVM 宿主。需要可访问 `/dev/kvm` 和 `qemu:///system` 的受信任维护者账号、本机 QEMU/libvirt、系统 Python 3（Ubuntu 24.04 的 `python3-libvirt`）和仓库所需的 Node/pnpm。虚拟机需能从原始磁盘启动，镜像由维护者准备并安装自启的 QEMU guest agent，大小不超过 8 GiB。

暂存目录必须是维护者拥有的绝对真实路径，供这一探针专用，组和其他用户均无写权限。按宿主管理策略让系统 libvirt 能访问暂存目录中的 VM 磁盘（例如位于已批准的本机镜像目录下）。维护者提供已独立核对的镜像 SHA-256。

```sh
export ITERVANE_RUNNER_PROBE_ROOT=/absolute/probe-staging
export ITERVANE_RUNNER_PROBE_IMAGE=/absolute/trusted-probe.raw
export ITERVANE_RUNNER_PROBE_IMAGE_SHA256='REPLACE_WITH_VERIFIED_SHA256'
export ITERVANE_RUNNER_PROBE_LOCALE=zh-CN
pnpm probe:runner-vm
```

配置中 SHA-256 取本轮镜像的实际小写十六进制值。语言支持 `zh-CN` 与 `en`，缺省英文。输出保存到忽略提交的 `.reports/p0/runner-vm.json`。记录包含结果码、探针运行 ID、已校验的镜像摘要和源码指纹。退出码 0 表示本轮生命周期通过，1 表示失败，2 表示当前条件阻断。普通执行时限 180 秒，外层 200 秒回收失联驱动。挂起时以保留的 `run.json` 为线索，由维护者核对原 libvirt 调用已结束、同一 UUID/名称的域不存在和该盘未被引用，再处理原目录。

## 3. 本批验收记录

| 检查 | 证据 |
| --- | --- |
| 原生调用序列 | WSL 下 9 项 Python 测试通过，覆盖摘要、配置拒绝、取消、超时、启动应答丢失、清理证据未知和目录占用。使用 libvirt 替身验证调用与状态。 |
| 本机原生前置 | WSL 实跑返回 `kvm_unavailable`。Windows 双语 CLI 在 `zh-CN` 返回预期阻断码。 |
| 工程回归 | TypeScript 严格检查、94 项单元与 83 项真实 PostgreSQL 集成通过。GitHub Verification 运行宿主测试、现有真实浏览器及可信扫描器回归。 |
| 真实 KVM 证据 | 待验。D2 还需实际任务协议、网络、宿主与跨任务隔离、资源/进程树清理实证，之后由 D3 接真实项目。 |

本批只面向可信镜像的生命周期验证。现有 API、Worker、外部 MCP、门户和发布适配不消费此回执。项目执行、源码扫描和正式发布资格仍由原闸门判定。
