# ADR 0004：隔离资格与源码检查准备分开

- 日期：2026-11-18；状态：P1-D1 采用。
- 前置：ADR 0001/0002；v6 的一次性 VM、当前授权与领域事实保持。

当前没有经验证的 KVM 宿主。开发结构化 Runner 契约、密码学绑定的 Git 快照校验器、扫描适配器和不可变检查计划，但不接通生产 VM 驱动或通过环境变量放行不可信执行。将“请求的 commit”“准备的计划”“验证过的快照”“实际扫描报告”区分为不同事实。

检查计划在 Worker 的 source.inspect 工具入口内，使用既有租约/fence/当前项目权限保存。它仅声明待做工作和约束，不是作业已开始或安全扫描证据。每个 run 唯一，不因手动重试改写。API、MCP 和门户只读同一领域记录。

快照校验重新计算 Git blob/tree/commit 对象，另计算 SHA-256 manifest；避免只信任客体自报 commit 或只哈希一个不明来源压缩包。生产获取/解析仍在隔离环境，当前库不提供网络或解压接口。扫描器采用受保护 profile，输出仅以允许字段归一化，异常或覆盖不足不能变成 clean。

正式 VM 控制器计划复用 QEMU/KVM + libvirt；先证明镜像/资源/网络/取消/销毁和隔离，再提供有界 job API。Worker 不获得宿主管理能力，Agent 不传任意 shell 命令。生产回执必须与当前执行权、计划、版本、快照和下游真实状态绑定；这些 D2/D3 协议不能用 D1 测试替身冒充。

真实 CLI 只能在维护者生成的可信合成样例上提前验证，且与正式任务证据分开。D1 不开放上传报告或接受 claimed verified 的端点，不把 fixture 成功写入业务任务。

参考：[Git 对象](https://git-scm.com/book/en/v2/Git-Internals-Git-Objects)、[Gitleaks CLI](https://github.com/gitleaks/gitleaks/tree/v8.30.1)、[Trivy filesystem](https://trivy.dev/docs/latest/references/configuration/cli/trivy_filesystem/)。
