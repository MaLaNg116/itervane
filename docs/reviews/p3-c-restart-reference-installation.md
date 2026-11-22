# P3-C2c3c3c · 自托管重启参考安装导读

依赖 #105，固定代码与测试为 `e6d41d8adab69f421786d4109c02021f3f3d9715`。 [PR #106](https://github.com/MaLaNg116/itervane/pull/106) · [安装说明](../control-plane-restart.md)

1. `94fbf99` 让标准 API 接受安装方配置的可信路径，验证文档与当前受保护目标、发布映射及生效登记一致后注册写入口。加载器以对象交付 Fastify 实例，允许入口在启动前注册生命周期钩子。API 只读取登记文档，原生写凭证和独立核对凭证由专用 Worker 配置。 [加载器](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/packages/control-plane/src/runtime/installed-api.ts) · [标准启动](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/packages/control-plane/src/entries/server.ts) · [配置示例](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/.env.example)
2. `37dcd59` 用真实 PostgreSQL 验证默认模式、缺少正式诊断或门户、错误路径、未登记材料、错配策略以及轮换后的旧 API 拒绝提交。新登记重新启动后可入队，API 生命周期钩子如期执行。同一标准应用的正向和中断托管场景改走正式装机加载器。 [真库测试](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/packages/control-plane/test/integration/inspections.test.ts#L4322) · [原生联验入口](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/packages/control-plane/test/native/worker-inspection.ts#L926)
3. `e6d41d8` 保存环境、凭证范围、登记步骤、验收和轮换说明。 [自托管说明](https://github.com/MaLaNg116/itervane/blob/e6d41d8adab69f421786d4109c02021f3f3d9715/docs/control-plane-restart.md)

TypeScript、246 项单元和四项 PostgreSQL 17.12 专项通过。专用重启端点以同一应用的托管联验核对实际安装、批准执行、只读接管与恢复结果。 [托管检查](https://github.com/MaLaNg116/itervane/pull/106/checks)
