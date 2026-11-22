# P2-E-D3-D3-C · 真实上线故障与恢复导读

依赖 [批准后变更验收 #64](https://github.com/MaLaNg116/itervane/pull/64)。固定代码版本 `bb78dd961a601fd8d16d91c903eef7dddf8539cf`。 [分批计划](../plans/p2-e-protected-release-faults.md)

1. 源码分支 `5b9db1015069be891233231a7b947831ac46fe39` 是标准应用的独立合成版本。先在 KVM 验证健康，再由测试宿主核对部署、网络和镜像，向本轮容器发送固定信号。Node 服务在原容器中从 200 变为 503。另一项保持应用 200，只停止本轮 Keycloak，核对受保护入口仍拒绝匿名访问。 [合成应用](https://github.com/MaLaNg116/itervane/commit/5b9db1015069be891233231a7b947831ac46fe39) · [真实信号和读回](https://github.com/MaLaNg116/itervane/blob/01ba5e0/packages/verification/src/native/komodo-probe.ts)
2. 每项有自己的任务与批准。在真实 Komodo 更新标识已入库后停止执行进程，新执行者持后继代次读回同一标识。Registry 导入、目标设置与派发分别有持久化步骤。记录派发次数、确认代次与保留的环境占用。未知更新的核对继续由 `standard-oci` 原生场景覆盖。 [已派发更新恢复](https://github.com/MaLaNg116/itervane/blob/01ba5e0/packages/control-plane/test/native/komodo-release-proof.ts)
3. 安装态发布 Worker 在两项故障中分别产生健康失败和凭证服务不可用的人工核验结果。对照中英文 HTTP/MCP、真实 PostgreSQL、原生更新标识和实际镜像，核对工作区及资源回收。 [故障验收](https://github.com/MaLaNg116/itervane/blob/01ba5e0/packages/control-plane/test/native/worker-inspection.ts) · [托管场景](https://github.com/MaLaNg116/itervane/blob/4d7d79a/.github/workflows/native-runner.yml)

本机 202 项单元、TypeScript、宿主 Bash 和合成应用语法检查通过。用固定合成源码在本机回环运行，发送信号后同一进程从 HTTP 200 转为 503，原版本字符串保持一致。托管 KVM 运行故障验收待归档。

首轮回归报 MCP 会话已断开，抽取后的单场景调用未等待结束即可进入外层关闭流程。`3ad30d3` 补上等待。运行故障组在目标登记阶段停下，两个用例共用了项目内必须唯一的应用名。`bb78dd9` 为两项用例分别登记应用，并按场景记录阶段和脱敏 HTTP 状态。 [首轮回归](https://github.com/MaLaNg116/itervane/actions/runs/44960177289/job/137017031081) · [故障组首轮](https://github.com/MaLaNg116/itervane/actions/runs/44960177289/job/137017030874)

更正后的故障组通过。应用异常场景实际从 200 变为 503，身份中断场景应用仍返回 200。两者均保持匿名 401，并分别记录 `release_rollout_health_failed` 和 `release_rollout_unavailable`。PostgreSQL 17.12 证实两项各只有一次派发，后继执行者持新的执行代次核对原更新，操作保留环境占用，业务执行槽已释放。两种语言的 HTTP 与 MCP 结果一致。报告源码指纹 `5a2f9fec1d0c984d91637645c9ca8b37c3f7780b7548fba2fbf7f04cf9f7c6f7`。 [托管实测](https://github.com/MaLaNg116/itervane/actions/runs/44961186575/job/137020213381)

合入前复核两项独立目标、隔离夹具归属、原生派发记录和 HTTP/MCP 查询结果。最终审查版本 `1f86f07af436745870fa0324d6758948f02e1d28` 与托管复跑的非文档内容一致。八组 KVM 和六项常规检查通过，已合入 `fa64dee92b6ef4fb1af9c0278dd2b4ca473027ac`。 [完整 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44961186575) · [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44963360437) · [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44963355942)
