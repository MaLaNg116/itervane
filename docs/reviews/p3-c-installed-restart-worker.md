# P3-C2c3c1 · 专用重启 Worker 导读

本批接续 #99，代码快照为 `05df30d586174ff69ebeec25d0cec07411b6c810`。 [PR #100](https://github.com/MaLaNg116/itervane/pull/100) · [安装与原生验收计划](../plans/p3-c-installed-restart-worker.md)

1. `3316903` 将 Komodo 读调用绑定到一个已登记部署。启动核对当前非管理员账号、密钥归属和配置指纹，读接口仅暴露固定的容器检查。安装时给专用账号配置目标的 `Read` 和 `Inspect`。 [读取适配器](https://github.com/MaLaNg116/itervane/blob/05df30d586174ff69ebeec25d0cec07411b6c810/packages/control-plane/src/runtime/release-komodo.ts) · [Komodo v2.3.4 原生权限](https://github.com/moghtech/komodo/blob/v2.3.4/bin/core/src/api/read/deployment.rs)
2. `08aa35b` 新增 `pnpm start:restart-worker`。部署者将三份受信文件和独立凭证注入专用进程，启动时核对环境、原发布映射及 Whiskers 写安装。队列只在配置范围领取重启动作，分派初次请求、人工续发和独立只读核对。 [安装配置](https://github.com/MaLaNg116/itervane/blob/05df30d586174ff69ebeec25d0cec07411b6c810/.env.example) · [启动入口](https://github.com/MaLaNg116/itervane/blob/05df30d586174ff69ebeec25d0cec07411b6c810/packages/control-plane/src/entries/restart-worker.ts) · [队列分派](https://github.com/MaLaNg116/itervane/blob/05df30d586174ff69ebeec25d0cec07411b6c810/packages/control-plane/src/runtime/installed-restart-worker.ts)
3. `05df30d` 验证启动配置、管理员身份拒绝、目标隔离、队列暂停及恢复结算。托管原生场景给另一非管理员账号配置 `Read` 与 `Inspect`，检查实际只读权限，并使用专用身份观察受控容器的停止与再启动。 [真库测试](https://github.com/MaLaNg116/itervane/blob/05df30d586174ff69ebeec25d0cec07411b6c810/packages/control-plane/test/integration/inspections.test.ts) · [原生权限场景](https://github.com/MaLaNg116/itervane/blob/05df30d586174ff69ebeec25d0cec07411b6c810/packages/verification/src/native/komodo-probe.ts)

## 验收与接续

TypeScript、246 项单元和缺少安装配置时的启动阻断通过。PostgreSQL 17.12 已验证派发、撤权后恢复结算和专用 Worker 队列分派。后者首轮在既有准入守卫中止，独立复跑通过。真库使用限定的外部响应夹具。 [托管 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/45007441246) · [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45007441274)

前置 #97 已通过同一标准应用的独立恢复检查，实际回执显示同一容器启动时间推进、匿名 401、授权健康 200。门户人工排队、续发、授权回执和同一应用的真实 Whiskers 执行由 C2c3c2 与 C2c3c3 继续验收。 [标准应用报告](https://github.com/MaLaNg116/itervane/actions/runs/45004903433/job/137154261966)
