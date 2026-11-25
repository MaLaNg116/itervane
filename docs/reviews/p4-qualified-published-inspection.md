# P4-D2b1 · 原生 Runner 固定规则扫描

接续 [#147](https://github.com/MaLaNg116/itervane/pull/147)。先看[本批计划](../plans/p4-qualified-published-inspection.md)与[固定源码扫描](p4-published-source-scan.md)。

1. `63d7ff7` 规则命令绑定任务、项目、镜像、长度和摘要。来宾在同一固定快照上运行三个扫描器，附加完整文件清单的规则回执。客户端重算来源清单摘要、各语言覆盖和报告摘要，核对匹配文件及坐标。 [命令与回执](https://github.com/MaLaNg116/itervane/blob/63d7ff7/packages/runner/src/published-inspection-command.ts) · [隔离扫描入口](https://github.com/MaLaNg116/itervane/blob/63d7ff7/packages/runner/src/guest-inspection.ts)
2. `fd70143` 原生控制器先核对工作区、工具资格、登记来源和租约，再接收有界命令。源码出站关闭后，固定规则命令进入一次性域内的只读扫描路径。带规则的回执有独立的 12 MiB 上限，既有来源检查和复验继续使用各自的协议上限。 [主机控制器](https://github.com/MaLaNg116/itervane/blob/fd70143/packages/runner/host/qualified_controller.py) · [来宾传输](https://github.com/MaLaNg116/itervane/blob/fd70143/packages/runner/host/source_guest.py)
3. `9148470` 验证命令篡改、项目换绑、缺失租约及回执校验。托管 `rule-samples` 场景新增独立固定源码扫描，要求三种扫描都有结果、健康样例命中被记录、租约缺失时未启动域、成功后域和工作区清空。 [主机回归](https://github.com/MaLaNg116/itervane/blob/9148470/packages/runner/host/test_qualified_controller.py) · [托管 Runner 验收](https://github.com/MaLaNg116/itervane/blob/9148470/packages/control-plane/test/native/rule-samples.ts)

本机 TypeScript、282 项单测和 80 项 Linux 主机测试通过，另有 8 项随平台跳过。提交 `5f8b88b69666033e8f2c54340b4ca4f109ced9f3` 的 19 项托管检查通过。独立检查回执中 Gitleaks 和 Trivy 均完成，Semgrep 覆盖 4 个文件，在 `server/app.mjs` 命中一次。断开租约的请求在域启动前结束，成功域清理后工作区为空。清单摘要为 `9463aa6782cda38f9008bf6e1ad124d6095f9e70add3801bcaaf62b7da7cb16a`，规则结果摘要为 `ccd12bc5c675b76bf1c73a866572f249ceec50b48de0a7be40bec7ba97da5d9f`。 [托管检查](https://github.com/MaLaNg116/itervane/actions/runs/45437193176/job/138598102941) · [原生证据工件](https://github.com/MaLaNg116/itervane/actions/runs/45437193176/artifacts/14941888964)

托管探针采用维护者固定的公开健康样例提交、合成规则发布记录及模拟工作流租约。后续批次覆盖正式任务选取、Agent 审计、独立复验和第二个登记项目。
