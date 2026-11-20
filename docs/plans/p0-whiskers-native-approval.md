# P0.5-B Whiskers 原生 MCP 人工确认

- 基线为 `6060b51`，Komodo 原生发布与恢复已取得独立证据。依据 v6 第 9–12、14 节、实施计划 P0.5/P3.1 和 [运行闸门](../decisions/0001-development-and-runtime-gates.md)。
- 复跑采用当前可解析的发布版 Whiskers 0.15.0，源提交 `e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4`。此前计划引用的 `v1.0.1` 当前无法从上游 Git 解析。MCP 审批语义以固定版本代码和实际调用为准。

## 1. 验证范围

在独立 GitHub 托管工作机启动官方固定镜像，管理本轮两项可信容器。管理界面、MCP 和凭证限定为本轮环境。开启原生 guardrail 与 Approvals，由独立浏览器人用身份完成实际批准，MCP 客户端只持短期受限密钥。验证过程使用固定容器重启，未涉及模型、生产主机或项目代码。

| 单元 | 交付 | 通过条件 |
| --- | --- | --- |
| B1 | 固定原生版本、仅本机服务和隔离样例 | 使用官方 digest；观察 Tool 返回真实样例状态；没有提交型任务与原生环境相连。 |
| B2 | 实际 MCP 和原生 Approvals 交互 | 未批准请求产生确认且目标未变化。批准角色与请求密钥分开；两者经原生批准 ID、目标和实参绑定。 |
| B3 | 同参续发、参数错误与单次授权验证 | 改变目标不能复用批准，原调用恰好成功一次，重放继续被拦截。实际容器启动时间及响应独立核对。 |
| B4 | 双语证据、复跑及固定版导读 | 保存已验证的上游版本、权限和授权边界。错误、超时和批准状态未知时停止发起新操作。 |

批准有效期和实例重启后的授权处理以原生契约为准，实测与源码证据分别记录。完整 P3 还需要实际业务授权、执行权、异常触发、目标版本和恢复等验证。本批不授予 API、Worker、门户或外部 MCP 运行资格。

参考 [Whiskers 0.15.0](https://github.com/LupusMalusDeviant/Whiskers/releases/tag/v0.15.0) · [原生直连审批](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/src/Whiskers/Services/Agent/Guardrails/DirectMcpCallGuard.cs)。
