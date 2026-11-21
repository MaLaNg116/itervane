# P2-D3-C2-A · 标准应用的独立 HTTP 基线导读

本批依赖 C1 的标准应用约定，交付可随客体封存的维护者检查。客体安装、构建、挂载和回收在后续批次接入。 [受保护执行计划](../plans/p2-d3-c2-protected-execution.md) · [离线依赖 #26](https://github.com/MaLaNg116/itervane/pull/26)

1. `3237ea2` 把健康、版本、合成数据、页面和前端编译资源检查放入独立程序。检查使用固定回环地址和短时限，记录稳定的检查编号和有限状态。 [基线程序](https://github.com/MaLaNg116/itervane/blob/3237ea2947a598631bf9853800eb12bea80f7a45/fixtures/runner/standard-web-baseline.mjs)
2. 程序检查状态、响应媒体类型与必要内容，回环请求拒绝跟随重定向。页面只允许选择同应用的固定资源目录，响应有严格字节上限。归一化报告只描述检查事实。 [请求及判据](https://github.com/MaLaNg116/itervane/blob/3237ea2947a598631bf9853800eb12bea80f7a45/fixtures/runner/standard-web-baseline.mjs)
3. Ubuntu 24.04 上用 Vite 8.3.8 构建维护者的可信夹具，再启动真实 Express 测试服务。7 项测试通过，健康基线五项通过；健康路由返回 503 时，另四项仍通过，整体结果失败。基线文件 SHA-256 为 `a1ee2a313dbbaea17ac3ca5bb012bb183005b20727362ddce0008f24c16966cc`。 [回归测试](https://github.com/MaLaNg116/itervane/blob/3237ea2947a598631bf9853800eb12bea80f7a45/fixtures/standard-app/test/application.test.mjs)

在已安装仓库依赖的可信开发环境执行 `pnpm --filter @itervane/standard-app build` 和 `pnpm --filter @itervane/standard-app test` 可复跑以上检查。实际项目执行与证据绑定仍等待合格客体。
