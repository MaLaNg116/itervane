# P4-C2b · KVM 规则样例执行与回执

接续 [#141](https://github.com/MaLaNg116/itervane/pull/141)。客户端协议固定于 `deafd300ee9bd0cd020e6ecc6c54bbc672390550`，虚拟机执行固定于 `1565324c72afea7af1d4e3fa1c796799ca9b6f42`。 [实施计划](../plans/p4-native-rule-samples.md)

1. Worker 重新编译待验候选，按候选、配置、样例及 Semgrep 工具链固定摘要。控制器以 UID、工作区和存活心跳约束单次操作，检查映像与命令绑定。 [客户端](https://github.com/MaLaNg116/itervane/blob/deafd300ee9bd0cd020e6ecc6c54bbc672390550/packages/runner/src/qualified-client.ts#L463)
2. 一次性 VM 接收有界样例命令。扫描账号在原来的系统调用、网络和设备边界中，只读访问封装工具及命令。来宾返回覆盖、版本和计数摘要，带域编号和命令摘要。控制器只从确认销毁的域接收回执。 [来宾暂存](https://github.com/MaLaNg116/itervane/blob/1565324c72afea7af1d4e3fa1c796799ca9b6f42/packages/runner/host/source_guest.py#L331) · [主机通道](https://github.com/MaLaNg116/itervane/blob/1565324c72afea7af1d4e3fa1c796799ca9b6f42/packages/runner/host/native_source.py#L221)
3. 客户端重算三份样例的完整性及通过判据。原生 CI 场景分两个域验证通过和误报，并核对提前失去授权及错误映像时没有启动域。 [原生脚本](https://github.com/MaLaNg116/itervane/blob/fbb869d155ba6cbb959a110f4bb4d8103680b545/packages/control-plane/test/native/rule-samples.ts#L35)

本地 TypeScript、274 项单元、WSL 75 项主机用例及 Bash、工作流解析通过。正式样例的 VM 验收见托管检查。C2c 把该回执加入候选验证任务、全局单槽和人工审核发布资格。 [托管检查](https://github.com/MaLaNg116/itervane/pull/142/checks)

首次托管运行完成映像准备、来宾交互和清理，首条规则回执的结论是 `unavailable`。测试输出已增加各样例的归一化失败原因，以便从下一次运行分辨引擎、超时和覆盖问题。 [首次运行](https://github.com/MaLaNg116/itervane/actions/runs/45406958411/job/138490150493)
