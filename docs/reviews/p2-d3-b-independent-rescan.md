# P2-D3-B · 隔离重放与复扫导读

本批以合入 [复验输入 #24](https://github.com/MaLaNg116/itervane/pull/24) 的 `b7d649e` 为基线，将正式复验输入接到合格 Runner 的真实扫描和 PostgreSQL 复扫回执账本。 [隔离重放与复扫计划](../plans/p2-d3-b-independent-rescan.md)

## 按调用顺序阅读

1. `4244219` 从当前授权的 run 取回已冻结输入，持久化复扫尝试，再发起 Runner 调用。授权脉冲复核租约与来源登记，写入回执前再次核对。数据库触发器同时约束当前执行权、原始扫描身份、复验策略与回执状态；不确定尝试在新租约下等待原 workspace 证实空闲。 [Worker 复扫协调](https://github.com/MaLaNg116/itervane/blob/4244219/packages/control-plane/src/runtime/formal-rescan.ts) · [回执迁移](https://github.com/MaLaNg116/itervane/blob/4244219/packages/control-plane/migrations/0020_formal_rescan_attempts.sql)
2. `5c3ee98` 将原始快照、目标清单、扫描配置和已发布补丁绑定到规范指令。`dc278b3` 通过现有受权 socket 和独立启用开关执行 `verify_source`。审查时核对外层请求与客体响应如何绑定同一命令和临时虚拟机。 [规范指令](https://github.com/MaLaNg116/itervane/blob/5c3ee98/packages/runner/src/verification-command.ts) · [Runner 控制器](https://github.com/MaLaNg116/itervane/blob/dc278b3/packages/runner/host/qualified_controller.py)
3. `b179159`、`36eb202` 让候选沿用原始快照的工作树和 npm 投影读取规则。候选按整棵文件集、单文件字节、模式位和预期清单摘要验证。npm 投影和工作树中的锁文件必须是同一 inode 的硬链接。取源进程完成重放，扫描进程在只读挂载上再次核对候选。 [客体重放](https://github.com/MaLaNg116/itervane/blob/36eb202/packages/runner/src/guest-verification-source.ts) · [配对扫描](https://github.com/MaLaNg116/itervane/blob/36eb202/packages/runner/src/guest-inspection.ts)
4. `4dbfd29` 检查每项发现与快照编号的绑定，再核对覆盖、版本、策略与数据库。Gitleaks 移动行仍作为原组残留；npm 新版本仍命中原公告时保留新发现。控制面据此记录新增、残留与退出，并保留可关联的证据编号。 [扫描对比](https://github.com/MaLaNg116/itervane/blob/4dbfd29/packages/runner/src/verification-scan-comparison.ts) · [对比回归](https://github.com/MaLaNg116/itervane/blob/4dbfd29/packages/runner/test/unit/verification-scan-comparison.test.ts)

## 验收路径

- PostgreSQL 回归覆盖同租约阻止重复分派，旧租约无法执行，只有原 workspace 空闲可由新租约续领，以及已记录回执重用和撤权之后的读取保护。 [集成用例](https://github.com/MaLaNg116/itervane/blob/4244219/packages/control-plane/test/integration/inspections.test.ts)
- `4f43f47` 的托管 KVM 流程对 dotenv 模板修复、核准的 npm 成对升级及无发现原稿分别复扫。子进程通过正式租约和受权 socket 进入一次性客体，保留固定快照、对应扫描摘要和清理结果。原稿固定为只包含两份 npm 清单的样例提交。 [宿主验收](https://github.com/MaLaNg116/itervane/blob/4f43f47/packages/control-plane/test/native/worker-inspection.ts) · [复扫执行](https://github.com/MaLaNg116/itervane/blob/4f43f47/packages/control-plane/test/native/worker-verification.ts) · [原稿样例](https://github.com/MaLaNg116/itervane/tree/49799e18f4f63cf22767a9cd8054cab979b9b6d2)
- D3-C 接入平台基线、针对性测试和镜像证据。D3-D 接入生产 Worker 调度、内置复验 Agent、返修和双语读面。发布继续由 P2-E 冻结候选、审批并核对实际运行状态。 [P2-D3 完整计划](../plans/p2-d3-formal-verification.md)

## 实机证据与合入复核

托管 KVM 验证固定代码 `823537cb9d89867448a148db2275fc2f81fdbbc6`。下载的 `runner-worker-inspection.json` 记录 PostgreSQL 17.12 下的三个独立客体，源码指纹与同一提交本地导出一致。每条路径首次执行一次，复读命中同一回执，宿主已核对域和暂存目录清空。 [托管验收](https://github.com/MaLaNg116/itervane/actions/runs/44887116357) · [PR CI](https://github.com/MaLaNg116/itervane/actions/runs/44887120609)

| 样例 | 比较结果 | 复扫回执 SHA-256 |
| --- | --- | --- |
| dotenv 模板 | Gitleaks 的目标发现退出，另 7 组仍存在。 | `6c91076fafda942f2747f7bd0c21df62581d3eb913c30348f5ed76e6ae19f2af` |
| npm 成对升级 | 目标公告退出，另 6 组仍存在。其中两组在升级版本重新命中，按版本保留为两条新记录。按公告与包坐标核对新增组为零。 | `ac3bb47ba5621ad64c95cb2fc333bd16907d1dc7ec19b76516360f536dd60876` |
| 无发现原稿 | 清单与目标一致，单次扫描、零发现、无补丁。 | `7212631d3dcea9d3275beb25b2ec0f7b98ebd2420636ae16db1c8af394715aa5` |

合入前复核了规范命令和固定候选的绑定、独立只读扫描、执行权续领、清理与回执重用。Linux 149 项单元、44 项宿主和 117 项真实 PostgreSQL 集成通过。常规 CI 同时覆盖现有门户双语和扫描器回归。 [分项审查](https://github.com/MaLaNg116/itervane/pull/25)
