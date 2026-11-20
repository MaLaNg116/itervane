# P0.5-B Review Guide：Whiskers MCP 原生人工确认

- 基线为 `6060b51`，依赖 PR #13 的 Komodo 原生证据与既有运行闸门。固定实现为 `b4e0f69211e57bcb5ffee364e7dc6eee22a341f0`。
- 上游为 Apache-2.0 的 Whiskers 0.15.0，源码 `e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4`。本次使用其 Linux amd64 官方镜像 `sha256:876510ea689a7cca7c6d36a8c1d60f5b5cf09549ece6d4ad2d54e29aa599148c`。此前计划引用的 `v1.0.1` 未能从上游 Git 解析，按当前可固定版本记录兼容性。 [实施计划](../plans/p0-whiskers-native-approval.md) · [上游发布](https://github.com/LupusMalusDeviant/Whiskers/releases/tag/v0.15.0)

## 1. 阅读顺序

1. 专用 GitHub 托管测试机拥有本轮 Docker 守护进程。Whiskers 服务只发布 loopback 端口，两个可信容器使用已有 fixture 并采用 `none` 网络。固定策略只允许 `get_container_details` 和 `restart_container`，写操作需要原生确认。口令写入仅本轮使用的文件，临时数据保存在服务内的 tmpfs。 [工作流](https://github.com/MaLaNg116/itervane/blob/b4e0f69211e57bcb5ffee364e7dc6eee22a341f0/.github/workflows/native-whiskers.yml) · [启动与核对](https://github.com/MaLaNg116/itervane/blob/b4e0f69211e57bcb5ffee364e7dc6eee22a341f0/packages/portal/test/native/whiskers-fixture.ts) · [策略](https://github.com/MaLaNg116/itervane/blob/b4e0f69211e57bcb5ffee364e7dc6eee22a341f0/fixtures/whiskers/guardrails.json)
2. 原生登录表单提供防伪令牌，表单提交复用浏览器的 cookie 会话。管理员通过原生 Settings 创建两个受限 Write 密钥，经真实 Approvals 页面查看具体工具、服务器和容器参数并批准。两把服务密钥不承担批准角色。浏览器只访问本轮原生服务，诊断采用固定状态码，页面和请求内容不进入回执。 [原生管理与审批页面验收](https://github.com/MaLaNg116/itervane/blob/b4e0f69211e57bcb5ffee364e7dc6eee22a341f0/packages/portal/test/native/whiskers-ui.ts)
3. SDK 客户端固定访问 `local` 和完整容器 ID。初次请求产生批准 ID，待批期间重复请求得到同一 ID。人为批准后，另一密钥或另一个目标都需要新批准。同一密钥断开重连后可按原参数执行一次，之后再次调用要求新批准。 [有界 SDK 客户端](https://github.com/MaLaNg116/itervane/blob/b4e0f69211e57bcb5ffee364e7dc6eee22a341f0/packages/verification/src/native/whiskers.ts) · [真实流程](https://github.com/MaLaNg116/itervane/blob/b4e0f69211e57bcb5ffee364e7dc6eee22a341f0/packages/portal/test/native/whiskers.ts)
4. 测试比较两项 Docker 容器 ID 和 `StartedAt`，经已批准调用只看到目标重启，随即验证其 HTTP 健康和原生日志中的唯一重启记录。经批准的操作响应失联时，只读取目标状态，停止发起续写。 [原生审计与测试结果](https://github.com/MaLaNg116/itervane/actions/runs/44715989093)

## 2. 运行证据

[原生实测 44715989093](https://github.com/MaLaNg116/itervane/actions/runs/44715989093) 返回八项通过，源码指纹为 `904c373559c2c226d4ec1a1ff50526d951aec3abaa8a1434a009853921fad751`。

| 动作 | 已观察证据 |
| --- | --- |
| 原请求待批及浏览器批准 | 同一原生批准 ID `b4530c9a6fde4212bc038eb0022e491e`。容器在批准后仍等待正式发送。 |
| 更换 MCP 密钥 | 原请求需要新批准 `779a63784c7846c08fecb2d05ef5c828`，运行状态保持。 |
| 更换容器 | 改变实参产生新批准 `d1de60cf221242afb598476cddbc993f`，运行状态保持。 |
| 重连并按原参执行 | 目标启动时间推进，另一容器未变化，健康检查通过，原生审计页有唯一匹配的操作。 |
| 同参再次发送 | 授权已消费，新批准 ID 为 `2ae8aa47db4341cc8f2c6b4fcc7e77ee`。 |

TypeScript 严格类型和 101 项单元通过。Windows 直接调用在 en 与 zh-CN 均以专用运行条件缺失阻断。GitHub Actions 的 `Native Whiskers` 可手动复跑，脱敏报告保存为 `.reports/p0/whiskers-native.json`，并归档 `whiskers-native-evidence`。 [回执解析回归](https://github.com/MaLaNg116/itervane/blob/b4e0f69211e57bcb5ffee364e7dc6eee22a341f0/packages/verification/test/unit/whiskers-native.test.ts)

## 3. 验收边界

原生批准后可续发的窗口在 0.15.0 源码中是 10 分钟，许可保存在原生服务进程中。本次实际验证了参数、身份、重连及单次消费。真实等待到期、实例重启恢复、正式平台审批与下游批准绑定以及完整 P3 还需验证。实测使用单信任域，真实项目仍受现有 Runner、目标、审批和执行权闸门约束。 [原生窗口与绑定实现](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/src/Whiskers/Services/Agent/Guardrails/DirectMcpCallGuard.cs)
