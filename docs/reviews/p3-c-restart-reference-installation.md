# P3-C2c3c3c · 自托管重启参考安装导读

依赖 #105，固定代码与测试为 `e6d41d8adab69f421786d4109c02021f3f3d9715`。 [PR #106](https://github.com/MaLaNg116/itervane/pull/106) · [安装说明](../control-plane-restart.md)

1. `94fbf99` 让标准 API 接受安装方配置的可信路径，验证文档与当前受保护目标、发布映射及生效登记一致后注册写入口。加载器以对象交付 Fastify 实例，允许入口在启动前注册生命周期钩子。API 只读取登记文档，原生写凭证和独立核对凭证由专用 Worker 配置。 [加载器](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/packages/control-plane/src/runtime/installed-api.ts) · [标准启动](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/packages/control-plane/src/entries/server.ts) · [配置示例](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/.env.example)
2. `37dcd59` 用真实 PostgreSQL 验证默认模式、缺少正式诊断或门户、错误路径、未登记材料、错配策略以及轮换后的旧 API 拒绝提交。新登记重新启动后可入队，API 生命周期钩子如期执行。同一标准应用的正向和中断托管场景改走正式装机加载器。 [真库测试](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/packages/control-plane/test/integration/inspections.test.ts#L4322) · [原生联验入口](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/packages/control-plane/test/native/worker-inspection.ts#L926)
3. `e6d41d8` 保存环境、凭证范围、登记步骤、验收和轮换说明。 [自托管说明](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/docs/control-plane-restart.md)

TypeScript、246 项单元和四项 PostgreSQL 17.12 专项通过。正式装机入口在同一应用上的两条托管路径均通过。证据归档的源码指纹为 `73f078426b578bf78985e5682d4a50aaf4fc7e6ec28adc403176af4cc274be66`。 [固定代码联验](https://github.com/MaLaNg116/itervane/actions/runs/45014647418/job/137184243333)

- 正向路径用独立 Komodo 读身份核对同一容器。恢复后匿名请求为 401、授权健康请求为 200。一笔续发、一笔确认及一条原生审计关联同一回执，释放全局槽和环境占用。HTTP 与外部 MCP 读到同一结果。回执摘要为 `3e4b315365975e7cde6337fb137a94d2234dd213ad9607aa98bff99db42fec58`。
- 在实际续发后中断旧 Worker、撤销平台批准，再由新 Worker 按执行权代次 13→14 只读接管。恢复后入口仍为 401／200，结算保留 `native_unconfirmed` 和环境占用并阻断竞争发布。回执摘要为 `7dd039446c166fa414f8e108eeab770f17f26ec4af030a8c8729d38363b4e617`。 [证据产物](https://github.com/MaLaNg116/itervane/actions/runs/45014647418/artifacts/14751433020)
