# P4-D2b1 · 原生 Runner 固定规则扫描

接续 [#147](https://github.com/MaLaNg116/itervane/pull/147)。先看[本批计划](../plans/p4-qualified-published-inspection.md)与[固定源码扫描](p4-published-source-scan.md)。

1. `63d7ff7` 规则命令绑定任务、项目、镜像、长度和摘要。来宾在同一固定快照上运行三个扫描器，附加完整文件清单的规则回执。客户端重算来源清单摘要、各语言覆盖和报告摘要，核对匹配文件及坐标。 [命令与回执](https://github.com/MaLaNg116/itervane/blob/63d7ff7/packages/runner/src/published-inspection-command.ts) · [隔离扫描入口](https://github.com/MaLaNg116/itervane/blob/63d7ff7/packages/runner/src/guest-inspection.ts)
2. `fd70143` 原生控制器先核对工作区、工具资格、登记来源和租约，再接收有界命令。源码出站关闭后，固定规则命令进入一次性域内的只读扫描路径。带规则的回执有独立的 12 MiB 上限，既有来源检查和复验继续使用各自的协议上限。 [主机控制器](https://github.com/MaLaNg116/itervane/blob/fd70143/packages/runner/host/qualified_controller.py) · [来宾传输](https://github.com/MaLaNg116/itervane/blob/fd70143/packages/runner/host/source_guest.py)
3. `9148470` 验证命令篡改、项目换绑、缺失租约及回执校验。托管 `rule-samples` 场景新增独立固定源码扫描，要求三种扫描都有结果、健康样例命中被记录、租约缺失时未启动域、成功后域和工作区清空。 [主机回归](https://github.com/MaLaNg116/itervane/blob/9148470/packages/runner/host/test_qualified_controller.py) · [托管 Runner 验收](https://github.com/MaLaNg116/itervane/blob/9148470/packages/control-plane/test/native/rule-samples.ts)

本机 TypeScript、282 项单测和 80 项 Linux 主机测试通过，另有 8 项随平台跳过。托管探针已成功打包，实际 KVM 回执待该 PR 检查产出。托管探针使用维护者固定的公开健康样例提交、合成规则发布记录与模拟工作流持有的 Runner 租约。正式任务读取数据库中的规则快照、Agent 审计读证据、正式复验和第二个登记项目的复用验收仍在后续批次。
