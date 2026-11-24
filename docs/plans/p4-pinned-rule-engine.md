# P4-C2a · 固定 Semgrep CE 与样例执行器

接续 [#140](https://github.com/MaLaNg116/itervane/pull/140)。先准备可复现的 Semgrep CE 二进制依赖及受限样例执行器，为 C2b 的正式 VM 传输和控制面验证提供固定输入。 [P4-C 总计划](p4-candidate-validation.md)

1. 固定 Linux x86-64 的 Semgrep CE 1.170.0 及 Python 3.12 二进制依赖。准备脚本检查所有 wheel 摘要，断网安装到独立工具目录，再用可追查清单核对精确文件树。
2. 样例执行器从控制面候选重新编译配置和三个固定文件。使用本地配置、固定参数、版本和工具指纹。限制时长、读取尺寸及输出。忽略仓库配置和内联抑制，避免匹配行及原始报告进入平台。
3. 用实际 Semgrep CE 在可信、公开的合成样例上验收 1、0、0、错误规则和引擎指纹。验证正式端仍以 C2b 的一次性 VM 回执、授权与覆盖为准。

使用官方的发行版本及 CLI 约定。扫描器和项目规则的许可证分别记录，Itervane 自有代码继续采用 Apache-2.0。 [版本文件](https://pypi.org/project/semgrep/1.170.0/#files) · [CLI 参数](https://docs.semgrep.dev/cli-reference) · [许可证](https://docs.semgrep.dev/licensing)
