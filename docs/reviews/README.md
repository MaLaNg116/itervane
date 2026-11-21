# 分阶段交付与 Review 索引

本目录保存每次交付的代码导读。可以先积累交付，再按照这里的顺序逐批 review；未 review 的前置 PR 不自动合并，后续 PR 使用叠加分支明确依赖。

| 批次 | 交付范围 | PR | Review guide | 状态 |
|---|---|---|---|---|
| 001 | P0 起步：契约、模型循环、数据库与 MCP 探针、评测材料 | [#1](https://github.com/MaLaNg116/itervane/pull/1) | [P0 起步导读](pr-001-p0-foundation.md) | 自动检查通过，完整 P0 待验 |
| 002 | P1-A：身份、资源登记、持久化任务与排队取消 | [#2](https://github.com/MaLaNg116/itervane/pull/2)，依赖 #1 | [P1-A 导读](p1-a-project-task-foundation.md) | 本地验证和 CI 通过，完整 P1 待验 |
| 003 | P1-B：持久化调度、受控 preflight、外部 MCP、en/zh-CN | [#3](https://github.com/MaLaNg116/itervane/pull/3)，依赖 #2 | [P1-B 导读](p1-b-durable-worker-mcp.md) | 47 单元/50 PG 及 Linux CI 通过，完整 P1 待验 |
| 004 | P1-C：最小门户、真实 OIDC 登录、双语任务界面 | [#4](https://github.com/MaLaNg116/itervane/pull/4)，依赖 #3 | [P1-C 导读](p1-c-portal-login.md) | 48 单元/53 PG/9 浏览器及 Linux CI 通过，完整 P1 待验 |
| 005 | P1-D1：源码检查准备、Git 内容校验、扫描适配与可信样例 | [#5](https://github.com/MaLaNg116/itervane/pull/5)，依赖 #4 | [P1-D1 导读](p1-d-source-inspection.md) | 60 单元/58 PG/9 浏览器/5 真实 CLI 及三组 Linux CI 通过，VM 与完整 P1 待验 |
| 006 | P1-E：规则/Skill 查询、有限文本预审、脱敏报告、双语 API/MCP/门户 | [#6](https://github.com/MaLaNg116/itervane/pull/6)，依赖 #5 | [P1-E 导读](p1-e-rules-preaudit.md) | 73 单元/66 PG/15 浏览器/5 真实 CLI 及三组 Linux CI 通过，Runner 继续关闭 |
| 007 | P1-UX：门户设计、双语 GSAP 反馈、减少动效与会话/CSP 回归 | [#7](https://github.com/MaLaNg116/itervane/pull/7)，依赖 #6 | [P1-UX 导读](p1-ux-portal-design-motion.md) | 73 单元/66 PG/20 浏览器/5 CLI 及三组 Linux CI 通过 |
| 008 | P1-UX 后续：真实任务页验证、shadcn/ui 逐页迁移 | [#8](https://github.com/MaLaNg116/itervane/pull/8)，依赖 #7 | [组件迁移导读](p1-ux-shadcn-migration.md) | 73 单元/66 PG/21 浏览器通过，受测路径零 CSP 违规，[Linux CI](https://github.com/MaLaNg116/itervane/pull/8/checks) |
| 009 | P2-A 内置 ReAct、审计/修复/复验与检查点恢复 | [#9](https://github.com/MaLaNg116/itervane/pull/9)，基于已合入 #1–#8 的 main | [P2-A 导读](p2-a-agent-harness.md) | 92 单元、69 PG、21 浏览器和双语确定性样例通过；真实模型全路径与正式 Runner 待验 |
| 010 | P2-B 候选冻结、人工决定、失效与事务回归 | [#10](https://github.com/MaLaNg116/itervane/pull/10)，基于已合入 #9 的 main | [P2-B 导读](p2-b-release-candidate.md) | 92 单元、78 PG、21 浏览器通过；正式批准与发布资格待验 |
| 011 | P2-C 原子确认入队、环境占用和运行结果核对 | [#11](https://github.com/MaLaNg116/itervane/pull/11)，基于已合入 #10 的 main | [P2-C 导读](p2-c-release-reconciliation.md) | 92 单元、83 PG、21 浏览器通过；正式 Runner 和 Komodo 目标待验 |
| 012 | P1-D2-A 一次性 VM 生命周期探针 | [#12](https://github.com/MaLaNg116/itervane/pull/12)，基于已合入 #11 的 main | [D2-A 导读和复跑](p1-d2-libvirt-lifecycle.md) | 94 单元、83 PG、9 宿主流程测试通过；真实 KVM 与完整隔离待验 |
| 013 | P0.5-A Komodo 真实发布、升级和指定版本恢复 | [#13](https://github.com/MaLaNg116/itervane/pull/13)，基于已合入 #12 的 main | [Komodo 原生证据与导读](p0-komodo-native-delivery.md) | [三轮原生验证通过](https://github.com/MaLaNg116/itervane/actions/runs/44711600569)；Whiskers 和正式任务接入待验 |
| 014 | P0.5-B Whiskers 原生 MCP 观察、同参确认和单次重启 | [#14](https://github.com/MaLaNg116/itervane/pull/14)，基于已合入 #13 的 main | [Whiskers 原生证据与导读](p0-whiskers-native-approval.md) | [八项真机检查通过](https://github.com/MaLaNg116/itervane/actions/runs/44715989093)；正式平台绑定与过期实测待验 |
| 015 | P1-D2 托管 KVM 原生启动、设备和清理 | [#15](https://github.com/MaLaNg116/itervane/pull/15)，基于已合入 #14 的 main | [KVM 实测与导读](p1-d2-runner-native.md) | [两轮原生启动与错误摘要负例通过](https://github.com/MaLaNg116/itervane/actions/runs/44719921676)，客体作业和完整隔离待验 |
| 016 | P1-D2-B 命名客体作业通道、摘要回执和停止清理 | [#16](https://github.com/MaLaNg116/itervane/pull/16)，基于已合入 #15 的 main | [客体作业导读](p1-d2-guest-job.md) | [四种原生作业结果均已验证](https://github.com/MaLaNg116/itervane/actions/runs/44724749497)，完整隔离与正式扫描待验 |
| 017 | P1-D2-C 专用宿主身份、工作负载隔离及 QEMU 退出 | [#17](https://github.com/MaLaNg116/itervane/pull/17)，基于已合入 #16 的 main | [隔离验收导读](p1-d2-runner-isolation.md) | [七个实际临时域及限额检查通过](https://github.com/MaLaNg116/itervane/actions/runs/44731986107)，正式源获取与扫描进入 D3 |
| 018 | P1-D3-A 登记 HTTPS 源、固定 Git 对象与出口关闭 | [#18](https://github.com/MaLaNg116/itervane/pull/18)，基于已合入 #17 的 main | [Git 来源获取导读](p1-d3-source-acquisition.md) | [两轮真实 Git 获取及七轮原生回归通过](https://github.com/MaLaNg116/itervane/actions/runs/44737581998)，只读快照、离线扫描与正式 Worker 接入待验 |
| 019 | P1-D3-B 固定只读快照、封存扫描输入与双语回执 | [#19](https://github.com/MaLaNg116/itervane/pull/19)，基于已合入 #18 的 main | [客体离线扫描导读](p1-d3-offline-inspection.md) | [两轮真实离线扫描与九轮既有原生用例通过](https://github.com/MaLaNg116/itervane/actions/runs/44746001023)，正式 Worker 接入待验 |
| 020 | P1-D3-C1 独立本机控制器、检查回执与断连回收 | [#20](https://github.com/MaLaNg116/itervane/pull/20)，基于已合入 #19 的 main | [独立检查控制器导读](p1-d3-qualified-controller.md) | [真实扫描、三类准入拒绝及两个已启动域的停止通过](https://github.com/MaLaNg116/itervane/actions/runs/44753059024)，Worker 数据库准入与持久化进入 C2 |
| 021 | P1-D3-C2 正式 Worker 源码检查、回执发布和恢复 | [#21](https://github.com/MaLaNg116/itervane/pull/21)，基于已合入 #20 的 main | [正式源码检查导读](p1-d3-worker-inspection.md) | [正式 Worker 扫描、取消、撤权和崩溃重领通过](https://github.com/MaLaNg116/itervane/actions/runs/44771579026)，[108 单元、39 Runner、91 PG 和 21 浏览器通过](https://github.com/MaLaNg116/itervane/actions/runs/44771587898) |
| 022 | P2-D1 正式证据驱动的审计 Agent | [#22](https://github.com/MaLaNg116/itervane/pull/22)，已合入 main | [正式审计导读](p2-d1-formal-audit.md) | 最新提交[通过托管 KVM 验收](https://github.com/MaLaNg116/itervane/actions/runs/44788702741)，本机真实模型验证两条双语审计路径 |
| 023 | P2-D2 受控修复与候选制品 | [#23](https://github.com/MaLaNg116/itervane/pull/23)，基于已合入 #22 的 main | [受控修复导读](p2-d2-controlled-repair.md) | 正式队列、dotenv 模板与 npm 成对修复的 [托管 KVM 验收](https://github.com/MaLaNg116/itervane/actions/runs/44880952837) 通过，真实模型也已验证两条样例决策 |
| 024 | P2-D3-A 复验输入与候选来源核验 | [#24](https://github.com/MaLaNg116/itervane/pull/24)，基于 P2-D2 #23 | [复验输入导读](p2-d3-a-verification-input.md) | Linux 146 项单元与 116 项 PostgreSQL 集成测试通过。重放、复扫与镜像证据独立验收 |
| 025 | P2-D3-B 隔离重放与独立复扫 | [#25](https://github.com/MaLaNg116/itervane/pull/25)，基于已合入 #24 | [独立复扫导读](p2-d3-b-independent-rescan.md) | 两类修复及无发现原稿的 [托管 KVM 验收](https://github.com/MaLaNg116/itervane/actions/runs/44887116357) 通过，149 项单元、44 项宿主与 117 项 PostgreSQL 集成通过 |
| 026 | P2-D3-C1 标准应用离线依赖 | [#26](https://github.com/MaLaNg116/itervane/pull/26)，基于已合入 #25 | [离线依赖导读](p2-d3-c1-build-dependencies.md) | Linux 156 项单元通过，91 份 tarball 已写入缓存。[既有 KVM 执行回归](https://github.com/MaLaNg116/itervane/actions/runs/44887439228)通过，客体构建待验 |
| 027 | P2-D3-C2-A 标准应用独立 HTTP 基线 | [#27](https://github.com/MaLaNg116/itervane/pull/27)，基于已合入 #26 | [独立基线导读](p2-d3-c2-standard-baseline.md) | 可信样例真实构建和 7 项测试通过，[既有 KVM 执行回归](https://github.com/MaLaNg116/itervane/actions/runs/44887820849)通过。客体执行与镜像证明待验 |
| 028 | P2-D3-C2-B 固定候选的客体离线构建 | [#28](https://github.com/MaLaNg116/itervane/pull/28)，基于已合入 #27 | [客体离线构建导读](p2-d3-c2-guest-build.md) | [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44892525169) 已实测构建、锁漂移、缺包和清理，118 项 PostgreSQL 集成通过 |
| 029 | P2-D3-C2-C 同一候选的客体运行与受保护基线 | [#29](https://github.com/MaLaNg116/itervane/pull/29)，基于已合入 #28 | [客体基线导读](p2-d3-c2-guest-baseline.md) | 119 项 PostgreSQL 集成与 50 项宿主测试通过，[三组托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44894586700)全绿，已合入 main |
| 030 | P2-D3-C3-A 固定 OCI 基底和封装工具 | [#30](https://github.com/MaLaNg116/itervane/pull/30)，已合入 main | [OCI 输入导读](p2-d3-c3-image-inputs.md) | [托管 Linux](https://github.com/MaLaNg116/itervane/actions/runs/44896141493)与本机摘要一致，重复封装、解包、输入边界和既有 KVM 回归通过 |
| 031 | P2-D3-C3-B 同一客体组装和离线镜像扫描 | [#31](https://github.com/MaLaNg116/itervane/pull/31)，已合入 main | [镜像扫描导读](p2-d3-c3-guest-image-scan.md) | [四组 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44897356042)、120 项 PostgreSQL 和 59 项宿主测试通过 |
| 032 | P2-D3-C3-C 留存同摘要扫描的 OCI 制品 | [#32](https://github.com/MaLaNg116/itervane/pull/32)，已合入 main | [制品留存导读](p2-d3-c3-oci-artifacts.md) | 121 项 PostgreSQL、65 项宿主测试和[四组托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44899721011)通过 |
| 033 | P2-D3-D-A 正式复验事实和有界投影 | [#33](https://github.com/MaLaNg116/itervane/pull/33)，已合入 main | [正式复验事实导读](p2-d3-d-verification-evidence.md) | 四项真实 PostgreSQL 回执对照和[四组托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44899950264)通过，健康镜像和 503 前置失败均可复核 |
| 034 | P2-D3-D-B 受限 ReAct 复验角色和检查点恢复 | [#34](https://github.com/MaLaNg116/itervane/pull/34)，已合入 main | [复验角色导读](p2-d3-d-verification-agent.md) | 121 项 PostgreSQL、[四组托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44902685245)和同源码真实模型双语路径均通过 |
| 035 | P2-D3-D-C1 从已固定原稿或修复候选自动接续正式复验 | [#35](https://github.com/MaLaNg116/itervane/pull/35)，已合入 main | [Worker 复验导读](p2-d3-d-verification-worker.md) | 163 项单元、129 项真实 PostgreSQL、常规 CI 和[四组原生验收](https://github.com/MaLaNg116/itervane/actions/runs/44905411730)通过 |
| 036 | P2-D3-D-C2 按核验失败接续有界返修 | [#36](https://github.com/MaLaNg116/itervane/pull/36)，基于已合入 #35 的 main | [受控返修导读](p2-d3-d-repair-retry.md) | 本机 163 项单元和 136 项 PostgreSQL 通过，双代次[原生验收](https://github.com/MaLaNg116/itervane/actions/runs/44908117224)进行中 |

2026-11-20 首批合入复核覆盖 #1–#8，按依赖顺序合入 `main`，保留分项提交。每个 PR 的已审查版本、检查和合并提交可从上表追溯。合入前核对项目权限、撤权、任务事务和执行租约，复跑 73 项单元与 66 项真实 PostgreSQL 集成测试。源码检查仍只准备计划和验证可信样例，有限预审的报告仍不授予发布资格。正式 VM 执行、部署和运维依赖各自的后续验收。

P1-B 已验证的远端交付版本为 `74706f95881c6435b98f26983654b725463483d3`，[PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44255791193) 与 [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44255784496) 均通过。代码快照与证据见导读；后续仅补充文档，不把前置 PR 自动合并。

P1-C 最终代码快照为 `62f3ef82895880de6aee0fa5f3c525f0e31e209a`，[PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44314376241) 与 [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44314366272) 均通过。此后只同步导读/运行说明，不改变本批代码；#4 明确依赖未合并的 #3。

P1-D1 固定代码快照为 `314664e702bdc6802533f8398dc4e4cbac8e7f99`；文档交付版本 `041a066259f49f17d25a137cb979233fb3f3f790` 的 [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44324198709) 与 [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44324051943) 均通过 deterministic/portal/scanners 三组检查。随后仅补证据索引；没有给 KVM/真实 VM 执行放行。

P1-E 固定代码快照为 `1f93809aef42c70bce52f3dd1fac7af58d929358`，对应运行说明与固定源码链接见导读；后续仅整理文档/远端证据。保持 P2-A/P4/D2/D3 的独立验收，不将预审计入正式扫描或发布批准。

P1-E 文档交付版本 `54e095fd3add9a028105bf0141d95dbf0384efcc` 的 [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44501368994) 和 [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44501335089) 均通过 deterministic/portal/scanners 三组。Linux/本地浏览器与扫描器源码指纹一致；5 项 CLI 仍只验证可信样例，runtimeQualified=false。本次随后只补充 PR/证据索引。

P1-UX 固定代码/已验证交付为 `4234acdb5d9c664272417713389eeef433bc7db5`，[PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44663181433) 与 [push CI](https://github.com/MaLaNg116/itervane/actions/runs/44663174416) 均通过三组检查。本地与 Linux 指纹一致，完整 20 项真实浏览器通过；随后仅补文档证据。#7 的交付基于 #6，保留 Runner 和完整阶段的独立验收。

## 每批交付约定

1. 先提交该批开发计划，写明目标、依赖、验收和未覆盖事项。
2. 按需求点分别提交代码，使用中文 Conventional Commits；锁文件随引入它的依赖变更提交。
3. 每批使用独立 PR；前置 PR 未合并时，明确将其分支作为比较基线，避免重复展示所有历史变更。
4. 保存对应 guide：基线与代码版本、阅读顺序、设计原因、关键调用路径、测试证据、当前限制及建议检查点。
5. 实测记录区分通过、失败、待验；模拟响应、材料检查和接口存在都不代替端到端验收。
6. guide 使用固定代码版本的链接；后续修改同一文件时，旧交付的讲解仍然能对应原代码。

阶段开发进度与运行资格分别记录。基础设施待验不妨碍独立模块的开发和可信测试，但未通过隔离、审批、授权与下游验证的功能不能执行真实项目代码或基础设施变更。
