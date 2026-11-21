# P2-D3-B · 隔离重放与复扫导读

本批依赖 [复验输入 #24](https://github.com/MaLaNg116/itervane/pull/24)。按 [隔离重放与复扫计划](../plans/p2-d3-b-independent-rescan.md) 分步实现，当前已验证工作树材料和对比逻辑。

## 已验证的准备部分

1. `b179159` 让候选使用与原始快照相同的工作树和 npm 投影读取规则。候选按整棵文件集、单文件字节、权限位和预期清单摘要验证。npm 投影和工作树中的锁文件必须是同一 inode 的硬链接。Linux 夹具重放两次得到相同候选，覆盖替换清单、权限位和独立投影的拒绝。 [候选读回](../../packages/runner/src/guest-repair.ts) · [共享快照读取](../../packages/runner/src/guest-snapshot.ts) · [候选回归](../../packages/runner/test/unit/guest-repair.test.ts)
2. `4dbfd29` 先检查每项发现与其快照编号的绑定，以及受保护扫描的覆盖、版本、策略和数据库，再比较前后同组的命中数量。Gitleaks 移动行仍作为原组残留，npm 新版本仍命中原公告时保留新的发现。比较给出数量及原始证据编号，在完整复验中由平台判据决定阻断。 [扫描对比](../../packages/runner/src/verification-scan-comparison.ts) · [对比回归](../../packages/runner/test/unit/verification-scan-comparison.test.ts)

本地 Linux 的严格类型检查和 149 项单元测试通过。新的合格请求、只读扫描接入、实际重放与清理证据将在本批后续提交验证。
