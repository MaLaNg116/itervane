# P4-C2a · Semgrep CE 离线工具与样例执行

接续 [#140](https://github.com/MaLaNg116/itervane/pull/140)。封装固定于 `a881747b4c9cf648c83561e8ececa42b824ae25d`，执行器固定于 `a44be694bc111528bd5959d7161451f721ce2718`。 [实施计划](../plans/p4-pinned-rule-engine.md)

1. 固定 Semgrep CE 1.170.0、Linux x86-64 和 CPython 3.12 的 66 个 wheel。安装阶段只读已核对摘要的本地 wheel，通过规范化的文件与目录清单绑定 2,816 个文件。 [工具封装](https://github.com/MaLaNg116/itervane/blob/a881747b4c9cf648c83561e8ececa42b824ae25d/scripts/prepare-runner-rule-engine.py#L33) · [上游版本](https://pypi.org/project/semgrep/1.170.0/#files) · [许可证](https://docs.semgrep.dev/licensing)
2. 执行器核对工具目录、候选配置、固定样例路径和内容摘要。Semgrep 以本地单一规则、关闭遥测及内联抑制的固定参数运行。返回样例覆盖和命中数，原始匹配行留在扫描进程内。 [样例执行器](https://github.com/MaLaNg116/itervane/blob/a44be694bc111528bd5959d7161451f721ce2718/packages/runner/src/guest-rule-validation.ts#L89) · [CLI 参数](https://docs.semgrep.dev/cli-reference)
3. 在 Ubuntu 24.04 从同一 wheel 缓存独立构建两次，清单字节一致，工具指纹为 `f41bf91efe68bc56515a9824f13d4b41af7beaa317afd0063efffdaccd141a26`。实际 Semgrep 对合成样例命中 1、0、0，拒绝错误规则和错误引擎指纹。带内联抑制的违规样例仍命中。 [可信样例实测](https://github.com/MaLaNg116/itervane/blob/cbb6cbd63752a1a4d22c162e75d8753b8741bc22/scripts/probe-rule-engine.ts)

TypeScript 已通过。实测范围为可信合成样例和实际 Linux Semgrep CLI。下一批接入一次性 KVM 命令、运行租约与清理回执。 [托管检查](https://github.com/MaLaNg116/itervane/pull/141/checks)
