# P3-C2c2b2 · 受信安装与重启派发导读

本批接续 #95 的写安装登记。验收代码固定在 `1075ebe2b15ffd9b68ddaeb1a5a59c6392e04332`。正式写执行在 C2c3 的独立恢复结算与同一标准应用验收后接线。 [PR #96](https://github.com/MaLaNg116/itervane/pull/96) · [前置 PR #95](https://github.com/MaLaNg116/itervane/pull/95) · [阶段计划](../plans/p3-c-whiskers-restart-execution.md)

## 阅读顺序

1. `856f4a8` 为首次未发送的重启引入 `restart_not_sent`。数据库要求真实已领取的处置、当前全局槽及无持久化发送意图。关闭、任务转人工与释放槽必须一起提交。已写过意图的执行仍由原约束保留。 [迁移](https://github.com/MaLaNg116/itervane/blob/1075ebe2b15ffd9b68ddaeb1a5a59c6392e04332/packages/control-plane/migrations/0054_operations_restart_dispatch_outcomes.sql)
2. `1d0351c` 加载受信安装描述、实际策略与角色文件，核对固定镜像、材料摘要与单独持有的 Write 凭证。凭证只在受绑定客户端内部使用。平台连接前读取当前处置与安装资格，Whiskers 同一会话提供原生工具范围，发送前重新读取文件并以当前租约和批准提交意图。发出后的未知回执根据数据库中的意图决定下一步。 [安装读取](https://github.com/MaLaNg116/itervane/blob/1075ebe2b15ffd9b68ddaeb1a5a59c6392e04332/packages/control-plane/src/runtime/whiskers-writer-installation.ts) · [派发](https://github.com/MaLaNg116/itervane/blob/1075ebe2b15ffd9b68ddaeb1a5a59c6392e04332/packages/control-plane/src/runtime/operations-restart-worker.ts) · [租约与回执](https://github.com/MaLaNg116/itervane/blob/1075ebe2b15ffd9b68ddaeb1a5a59c6392e04332/packages/control-plane/src/runtime/operations-execution-lease.ts)
3. `1075ebe` 用 PostgreSQL 和协议响应夹具核对两个网络调用对应的落库意图、发送前换代与策略变更、关闭事务约束和响应丢失。托管 Whiskers 场景使用原生进程实际挂载的文件，加载绑定凭证后沿用同一个容器的原生审批、重启、观察及审计。 [真库测试](https://github.com/MaLaNg116/itervane/blob/1075ebe2b15ffd9b68ddaeb1a5a59c6392e04332/packages/control-plane/test/integration/inspections.test.ts) · [原生场景](https://github.com/MaLaNg116/itervane/blob/1075ebe2b15ffd9b68ddaeb1a5a59c6392e04332/packages/portal/test/native/whiskers.ts)

## 复核重点

- 平台审批、写安装和租约分别在何时重验。重点查看读取原生权限与提交发送意图之间发生策略变更或安装轮换时，适配器是否保持零工具 POST。
- 区分首次未发送与已存在原生请求的续发。首次未发送释放环境占用，后者即使未续发也必须保留原请求并只读核对。
- 收到一次已应答只表示下游工具提供了回执。环境占用交给核对阶段，独立确认容器启动时间、镜像及受保护入口才形成恢复证明。

## 验收记录

本机 TypeScript、232 项单元和迁移一致性通过。扩展 PostgreSQL 17.12 回归 10 项通过，既有撤权测试一度遇到 `operations_decision_owner_required`。包含该用例的第二轮五项专项全部通过。首次失败的具体原因待确认。

托管检验按 PR 检查记录归档。当前分开验证派发事务与原生挂载材料。将持久化处置、原生批准后派发及独立健康结算接入同一标准应用的工作由后续批次完成。 [托管检查](https://github.com/MaLaNg116/itervane/pull/96/checks)

原生 Whiskers `1075ebe` 的 19 项通过，含真实挂载策略装载和一次审批重启。初版 KVM 在既有诊断的日志读取处失败。分支仍携带只允许容器详情的旧夹具，`c75388a` 同步主线 `9f9d327` 已验收的三项只读名单，重新启动受影响的场景。 [原生报告](https://github.com/MaLaNg116/itervane/actions/runs/45002323151) · [日志失败作业](https://github.com/MaLaNg116/itervane/actions/runs/45002323209/job/137146348881) · [主线夹具修复](https://github.com/MaLaNg116/itervane/commit/9f9d3278a5451a95a6463aa23f9c18a3cf57181d)

合入前复核了实际发送前的策略、写安装和租约复核，首次未发送的结算，以及原生回执未知时的只读接管。浏览器首轮在下载固定中文字体时连接重置，同一版本复跑通过。固定复核版本 `19689b88ed9904fe97b892fa8ddc4cdfa6f96ea0` 的 17 项有效检查通过，已合入 `0a7f7558edad0330389efe743a86cfc2fe5470d5`。 [浏览器复跑](https://github.com/MaLaNg116/itervane/actions/runs/45029883147/attempts/2) · [推送检查](https://github.com/MaLaNg116/itervane/actions/runs/45029877828) · [九项托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45029877838) · [原生 Whiskers](https://github.com/MaLaNg116/itervane/actions/runs/45032129467) · [OCI 输入](https://github.com/MaLaNg116/itervane/actions/runs/45029877855)
