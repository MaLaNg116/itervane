# P0.5-A Komodo 原生发布与指定版本恢复

- 基线为 `149cfe7`。依赖 v6 第 10、11、14 节、实施计划 P0.5/P2.5 和 [ADR 0001](../decisions/0001-development-and-runtime-gates.md)。
- P2-C 已验证发布确认、唯一操作和结果核对的数据库机制。本批为这些机制取得真实 Komodo 协议和实际运行证据。正式发布仍需 D2/D3、真实修复复验和经过核验的发布目标。

## 1. 固定环境和职责

使用 Komodo Core/Periphery 2.3.4 的固定镜像，运行在 Linux x86-64 GitHub 托管的一次性工作机。Core 只向 loopback 映射，Periphery 只连接本次 Core。测试用 MongoDB 为 Komodo 自身依赖，平台数据库继续使用 PostgreSQL。Docker socket 只交给本轮固定版本的 Periphery，托管工作机只处理维护者信任的内置样例。应用和原生服务不接收仓库路径、主机地址或外部凭证。

测试初始化生成短期账号和凭证，只把必要的认证字段传给 Komodo。验证端通过固定资源、固定镜像仓库和 OCI digest 调用原生 API。测试创建与发布动作分别记录，外部 API 错误及原始服务日志不进入公共证据。原生写入结果未知时收集状态再终止试验，禁止自动重放。

## 2. 实施单元

| 单元 | 工作 | 通过条件 |
| --- | --- | --- |
| A1 | 导入固定发布资源的最小原生 API 和回执解析 | 校验 Core 版本、服务与 Deployment、固定 digest、更新 ID 与完成结果；拒绝重定向、异常响应、目标漂移和模糊结果。 |
| A2 | 启动独立的 Komodo 和可信样例 | 两个固定可信镜像通过本次 loopback registry 取得 manifest 与镜像内容摘要。执行端看不到本机或用户项目 Docker。 |
| A3 | 顺序发布 A、升级 B、恢复指定 A | 使用原生 Deploy 获得三条独立更新记录，独立核对实际容器配置、运行镜像标识及 HTTP 健康/版本。旧版本复核使用精确 digest。 |
| A4 | 双语状态、可信 CI 与 review guide | 保留版本、源提交、三轮脱敏证据与失败限制。保持已有门户、MCP、Worker、发布和运维资格。 |

原生 probe 证据与正式任务分开。P0.5 的 Whiskers 原生确认、P2 的隔离 Runner 接入、绑定领域审批与目标、受保护入口和运行恢复分别验收。此次证据使用独立报告，不满足完整 P0.5 汇总项。

参考 [Komodo 2.3.4](https://github.com/moghtech/komodo/releases/tag/v2.3.4)、[Core API](https://komo.do/docs/ecosystem/api)、[Deployment 配置和生命周期](https://komo.do/docs/deploy/containers)。
