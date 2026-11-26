# P5-B8 · 参考安装指定版本恢复导读

从一套干净参考安装开始，分别复验、批准和发布两个固定源码版本。两个版本沿用同一份冻结的依赖缓存、同一环境和保护入口。随后在这套安装中恢复已经核验的历史版本。 [本批计划](../plans/p5-reference-version-restore.md) · [前置 #169](https://github.com/MaLaNg116/itervane/pull/169)

1. `29b332b` 使用真实 Keycloak、KVM Runner、Registry、Komodo 和入口代理，比较两次发布的项目、登记、镜像、容器和版本。停止当前的合成容器后，MCP 启动只读诊断并提出恢复上一版。诊断从实际 Whiskers 读取容器和发布历史。 [双版本发布](https://github.com/MaLaNg116/itervane/blob/29b332b/packages/portal/test/native/reference-release.ts) · [诊断与恢复验证](https://github.com/MaLaNg116/itervane/blob/29b332b/packages/portal/test/native/reference-restore.ts)
2. `29b332b` 在批准前验证无执行入队，并核对 MCP 写凭证不能替代门户本人提交。批准人与提交人使用同一真实门户身份。恢复 Worker 的 Komodo 写权限绑定部署，使用另一个只读身份核对容器，随后对照双语门户、MCP、数据库回执与独立容器观察。 [恢复安装说明](../control-plane-restore.md)
3. `fc23759` 在独立托管作业中要求合格的 KVM、固定代码树、历史镜像、不同容器、独立读取栅栏、获批执行、授权健康和匿名拒绝。摘要只保留版本、标识、指纹与上下游核对结果。 [托管流程](https://github.com/MaLaNg116/itervane/blob/fc23759/.github/workflows/native-runner.yml) · [摘要判据](https://github.com/MaLaNg116/itervane/blob/fc23759/fixtures/runner/reference-version-restore.jq)

本地严格类型和 287 项单测、两份 Shell 的语法通过，Ubuntu jq 通过一正六负。两个源码版本的 `package.json` 与锁文件和参考输入一致。实际版本恢复以托管回执为准。模型使用固定 Anthropic 协议响应；应答丢失、过期、撤销及失效执行者继续由既有原生恢复回归验收。 [恢复应答中断](p3-c-native-restore-takeover.md) · [恢复授权失效](p3-c-native-restore-authority.md)

首轮托管作业执行到恢复安装。复现检查确认完整发布登记会被 Komodo 只读适配器的严格参数校验拒绝。夹具现在沿用生产 Restore Worker 的 `targetForKomodo`，独立读回使用同一绑定字段，并给每一步安装验证保留脱敏诊断。 [首轮作业](https://github.com/MaLaNg116/itervane/actions/runs/45764974089/job/139723603517) · [生产字段转换](../packages/control-plane/src/runtime/formal-komodo-steps.ts)
