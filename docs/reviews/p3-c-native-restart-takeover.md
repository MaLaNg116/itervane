# P3-C2c3c3b · 原生重启中断与只读接管导读

依赖 #104 的同一应用正向实证，固定验收代码为 `9c2385f3bedc53c3ce53fdeccb4ad524dd01d795`。 [PR #105](https://github.com/MaLaNg116/itervane/pull/105) · [阶段计划](../plans/p3-c-native-restart-loop.md)

1. `9ffe0a3` 在一次性 PostgreSQL 中仅为指定处置的原生成功应答设置事务暂停。收到实际等待者后才终止旧进程，检查数据库连接退出，随后清除测试触发器。真库用例确认暂停期间已持久化发送意图，成功应答等待提交。 [中断点](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/packages/control-plane/test/native/restart-crash-barrier.ts) · [PostgreSQL 用例](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/packages/control-plane/test/integration/inspections.test.ts#L3296)
2. `85245df` 在第一轮已恢复的同一应用上重新诊断和批准。原生重启发生后结束 Worker，撤销平台批准，再启动新进程。验收核对 HTTP 和 MCP 回执、原始发送意图、无确认应答记录、实际健康恢复、执行权代次推进和发布互斥。 [中断与接管](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/packages/control-plane/test/native/restart-proof.ts) · [专用进程](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/packages/control-plane/test/native/worker-inspection.ts#L1163)
3. `998e313` 要求第二次实际重启仅新增一条 Whiskers 审计。应用保持受保护，Worker 只读核对后进入等待人工，环境继续占用并释放全局槽位。 [托管证据断言](https://github.com/MaLaNg116/itervane/blob/9c2385f3bedc53c3ce53fdeccb4ad524dd01d795/.github/workflows/native-runner.yml)

本机 TypeScript、246 项单元和四项 PostgreSQL 17.12 专项通过。专项覆盖应答提交、未知许可、旧执行权和撤销。固定代码的托管运维场景通过，报告指纹为 `52c6bf5e1e955bc62b4eeec34b798bf2a18d98f5e6d64bfbffa7065019949c9f`，接管证明摘要为 `a6a5f82e5b1a7fc9a0762abcff7cdc54c670f1af2e891b3196814f6d4c066f16`。 [托管实证](https://github.com/MaLaNg116/itervane/actions/runs/45013638152/job/137181164011)

同一容器启动时间由 `2026-11-22T10:55:52.270186625Z` 推进至 `2026-11-22T10:56:00.759553585Z`。故障场景只有一次续发和一次新增的原生重启审计，写入应答为零。平台批准已撤销，新 Worker 以代次 14 接续代次 13 的操作。真实健康 200、匿名 401，HTTP 和 MCP 回执均为待人工核对。执行槽释放，环境继续占用并阻断冲突发布。
