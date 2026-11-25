# P4-D2a · 已发布代码规则扫描固定源码

接续 [#146](https://github.com/MaLaNg116/itervane/pull/146)。阅读时先看[本批计划](../plans/p4-published-source-scan.md)和[规则快照导读](p4-task-rule-snapshots.md)。

1. `c591428` 从任务快照逐项取出代码规则引用，重算版本和人工审核摘要，再按原验证计划重建样例回执。原验证与当前执行可使用不同镜像，Semgrep 版本和工具文件摘要须一致。已发布包的键用于标识扫描结果。 [规则准备](https://github.com/MaLaNg116/itervane/blob/c591428/packages/runner/src/published-code-rules.ts)
2. `d42233a` 按 JavaScript、TypeScript 声明从核验后的 Git 文件清单选取目标，将核对过的字节写入隔离扫描器的临时目录。原文件路径、权限和摘要与临时目标成对绑定。Semgrep 使用固定本地配置，报告必须覆盖全部目标，输出保留原路径和命中坐标。摘要、范围、规则键、位置和覆盖状态均可依照同一份固定清单复核。 [来宾入口](https://github.com/MaLaNg116/itervane/blob/d42233a/packages/runner/src/guest-published-code-scan.ts) · [证据核对](https://github.com/MaLaNg116/itervane/blob/d42233a/packages/runner/src/published-code-scan.ts)
3. `953a8e0` 检查候选和审核内容变动、Semgrep 输入变动、样例结果重算、覆盖遗漏、重复、越界坐标和结果失配；执行真实锁定的 Semgrep 源码 Smoke。 [绑定用例](https://github.com/MaLaNg116/itervane/blob/953a8e0/packages/runner/test/unit/published-code-scan.test.ts) · [可重复执行的 Smoke](https://github.com/MaLaNg116/itervane/blob/953a8e0/scripts/probe-published-code-scan.ts)

本机 TypeScript 检查及 280 项单测通过，另有 8 项随平台跳过。WSL Ubuntu 24.04 上使用真实 Semgrep CE `1.170.0`，引擎输入为 `f41bf91efe68bc56515a9824f13d4b41af7beaa317afd0063efffdaccd141a26`。维护者生成的独立 Git 仓库固定到 `8cbaf18598e9621ffbac190cfc89c9cb44c63426`，实际覆盖 4 个 JavaScript 文件和 2 个 TypeScript 文件。只命中 `services/readiness.mjs` 与 `app/maintenance.mts`，正常反例、空文件和仓库声明忽略的路径都纳入覆盖核对。该次报告摘要为 `7eaed46f4ec56e5455c5b55c4c4642d295c6a61dd7f93b4743c5a104733a40de`。

Smoke 的规则发布和样例回执来自夹具，执行的是受信测试仓库的静态扫描。P4-D2b 验收授权工作流、真实一次性 VM、持久化审计和复验的接入。P4-D2c 验收后续登记项目上的真实规则复用。
