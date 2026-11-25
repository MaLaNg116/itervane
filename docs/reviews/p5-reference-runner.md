# P5-B2 · 参考 KVM Runner 安装导读

本批在参考控制面之后增加专用 KVM Runner 的可执行安装入口。维护者在可信宿主上准备固定镜像和离线输入，Worker 使用受限 Unix socket 连接同一套一次性虚拟机执行环境。 [本批计划](../plans/p5-reference-runner.md) · [安装说明](../reference-runner-installation.md) · [前置 PR #162](https://github.com/MaLaNg116/itervane/pull/162)

1. `5bd7034` 由维护者启动两个专用 systemd 单元。安装入口核对镜像内容与所有权、拒绝覆盖存活会话，并检查 Worker 对镜像、临时目录和 KVM 设备的访问。socket 组权限用于建立连接，请求仍由 Linux 对等进程的 UID 授权。 [安装入口](https://github.com/MaLaNg116/itervane/blob/5bd7034/packages/runner/ops/start-reference-runner.sh) · [控制器](https://github.com/MaLaNg116/itervane/blob/5bd7034/packages/runner/host/qualified_controller.py)
2. `35e7015` 从已封存输入生成 Worker 的正式复验和规则样例配置。核对 OCI 输入与构建配置的哈希绑定，输出只包含运行开关和非敏感指纹。 [配置入口](https://github.com/MaLaNg116/itervane/blob/35e7015/scripts/reference-runner-profile.ts)
3. `d50866e` 的托管 `protected-release-linked-health` 场景调用同一个安装器，以专用 Worker UID 查询就绪状态，再进入既有 VM、发布和健康事件流程。其余作业复用专用 libvirt 和 Controller 的启动函数。 [托管流程](https://github.com/MaLaNg116/itervane/blob/d50866e/.github/workflows/native-runner.yml) · [联验入口](https://github.com/MaLaNg116/itervane/blob/d50866e/fixtures/runner/run-qualified-session.sh)

本地已通过 TypeScript 检查、287 项单测、82 项 Linux Runner 用例和五份 Shell 脚本语法检查。固定配置的生成与改写 OCI 输入后的拒绝已验证。Linux socket 用例确认同组的未登记 UID 被拒绝，且拒绝发生在读取 Runner 状态或派发虚拟机之前。真实虚拟机和下游联验以本批托管 KVM 作业为验收证据，当前仍待完成。 [阶段验收要求](../implementation-plan-v2-ts-postgresql.md#p5-验证可靠性并形成可复现的开源交付)

参考启动使用 systemd 临时单元，需要在主机重启后用相同输入重新启动。完整参考环境的实际身份、模型和下游服务联跑、每条正向路径的独立运行次数，以及正式版本发布由 P5 后续批次验证。
