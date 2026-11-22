# P3-C2c3c3b · 原生重启中断与只读接管导读

依赖 #104 的同一应用正向实证，固定验收代码为 `9c2385f3bedc53c3ce53fdeccb4ad524dd01d795`。 [PR #105](https://github.com/MaLaNg116/itervane/pull/105) · [阶段计划](../plans/p3-c-native-restart-loop.md)

1. `9ffe0a3` 在一次性 PostgreSQL 中仅为指定处置的原生成功应答设置事务暂停。收到实际等待者后才终止旧进程，检查数据库连接退出，随后清除测试触发器。真库用例确认暂停期间已持久化发送意图，成功应答等待提交。 [中断点](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/packages/control-plane/test/native/restart-crash-barrier.ts) · [PostgreSQL 用例](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/packages/control-plane/test/integration/inspections.test.ts#L3296)
2. `85245df` 在第一轮已恢复的同一应用上重新诊断和批准。原生重启发生后结束 Worker，撤销平台批准，再启动新进程。验收核对 HTTP 和 MCP 回执、原始发送意图、无确认应答记录、实际健康恢复、执行权代次推进和发布互斥。 [中断与接管](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/packages/control-plane/test/native/restart-proof.ts) · [专用进程](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/packages/control-plane/test/native/worker-inspection.ts#L1163)
3. `998e313` 要求第二次实际重启仅新增一条 Whiskers 审计。应用保持受保护，Worker 只读核对后进入等待人工，环境继续占用并释放全局槽位。 [托管证据断言](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/.github/workflows/native-runner.yml)

本机 TypeScript、246 项单元和四项 PostgreSQL 17.12 专项通过。专项覆盖应答提交、未知许可、旧执行权和撤销。实际进程中断与原生恢复结果由托管 KVM 验证。 [托管运行](https://github.com/MaLaNg116/itervane/actions/runs/45013638152)
