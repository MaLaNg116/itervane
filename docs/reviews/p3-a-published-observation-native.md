# P3-A2-B2-C · 本轮发布容器的原生观察导读

接续 [只读观察执行 #70](https://github.com/MaLaNg116/itervane/pull/70)。原生夹具 `dcdc7aefcafb91beb209d5a22bf97258b4733080`，接续验收 `f477030faab14c45ff4feb0cd387d458e63d396a`。 [分批计划](../plans/p3-a-published-observation-native.md)

1. 托管场景先走原有独立 KVM、冻结源码、正式复验、审批、真实 Komodo 发布和受保护入口。通过后用本轮专用主机的固定 Whiskers 实例记录 Read 密钥。测试策略限定容器详情读取。 [Read 密钥夹具](https://github.com/MaLaNg116/itervane/blob/dcdc7aefcafb91beb209d5a22bf97258b4733080/packages/portal/test/native/whiskers-read.ts) · [只读策略](https://github.com/MaLaNg116/itervane/blob/dcdc7aefcafb91beb209d5a22bf97258b4733080/fixtures/whiskers/read-only-guardrails.json)
2. 以本轮环境和发布登记调用实际领域接收，运行普通安装方式的 Worker。比对 PostgreSQL 回执、容器状态、发布操作和实际 Komodo 容器。读取前后的容器身份一致，单个正式发布及派发记录保留。 [Worker 与证据对照](https://github.com/MaLaNg116/itervane/blob/f477030faab14c45ff4feb0cd387d458e63d396a/packages/control-plane/test/native/worker-inspection.ts#L901)
3. HTTP 与外部 MCP 比对同一任务，并逐语言比对事件。报告保留任务、run、绑定摘要、执行代次及清理状态。Worker 凭证由进程输入注入。验收器将独立断言观察关联、读取次数、共享执行槽和资源清理。 [独立验收条件](https://github.com/MaLaNg116/itervane/blob/f477030faab14c45ff4feb0cd387d458e63d396a/.github/workflows/native-runner.yml#L210)

本机 TypeScript、210 项单元及两个 Bash 接续脚本语法检查通过。业务诊断的独立 HTTP/MCP 接收及专用回执读模型由 A2-C 交付。

固定版本 `040548351c90fd9cb67b04f88ec4fd914f0fe3ee` 的原生接续通过。证据核对运行中的容器属于同一正式发布，读取、回执与发布派发各一次，HTTP 与 MCP 的任务状态一致，执行槽和 Whiskers 夹具已清理。 [Whiskers 回归](https://github.com/MaLaNg116/itervane/actions/runs/44968006870) · [原生接续](https://github.com/MaLaNg116/itervane/actions/runs/44968006971/job/137041290751) · [接续证据](https://github.com/MaLaNg116/itervane/actions/runs/44968006971/artifacts/14732933258)
