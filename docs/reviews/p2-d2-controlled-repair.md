# P2-D2 · 受控修复导读

本批以 #22 已合入 main 的正式审计为基线。首项交付固定修复交接输入，供合格 Runner 重建对应源码。 [草稿 PR #23](https://github.com/MaLaNg116/itervane/pull/23) · [实施计划](../plans/p2-d2-controlled-repair.md)

## D2.1 固定修复交接

1. 正式审计成功时，Worker 在同一事务保存修复输入、审计结果和任务事件。修复输入引用当前任务的提交、代次、检查计划、扫描回执、已发布审计检查点、发现编号及目录摘要。模型故障、部分扫描和待核对的审计继续使用原有人工路径。 [审计入库](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/src/service/formal-audit.ts#L83) · [交接契约](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/contracts/src/formal-repair.ts)
2. 重领后以同一运行的正式审计重新计算摘要，验证已保存的记录。已有完整审计而缺少交接记录时，可在当前授权租约中按原证据准备。迁移只添加交接表和当前执行权约束，数据库核对当前 run、执行权、来源、扫描、目录和实际发现清单。行一经保存即保留。 [交接服务](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/src/service/formal-repair.ts#L10) · [迁移约束](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/migrations/0015_formal_repair_inputs.sql#L15)
3. 本地通过 123 项单元测试和 102 项 PostgreSQL 集成测试，其中源码与审计专项 24 项。专项覆盖成功审计后的交接、模型失败、事务回滚、重领复用、按旧审计准备、不同运行或过期执行权拒绝、快照替换及历史不可变。测试用独立数据库为重领场景安排新的租约。 [数据库回归](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/test/integration/inspections.test.ts#L432)

## D2.2 结构化补丁和候选目录

1. 补丁契约固定原文件摘要和 UTF-8 字节区间，并限制文件数量、修改次数及替换字节数。客体从已验证的只读快照取得原始字节，再核对仓库、提交、清单、授权路径以及原文件摘要。保留未修改的内容与文件模式。 [补丁与工作区契约](https://github.com/MaLaNg116/itervane/blob/9d5bc2414d9342c8133eb4c8943e12aa4f4b0c9f/packages/contracts/src/formal-repair.ts) · [客体实现](https://github.com/MaLaNg116/itervane/blob/9d5bc2414d9342c8133eb4c8943e12aa4f4b0c9f/packages/runner/src/guest-repair.ts#L78)
2. 写入独立暂存目录，逐个校验实际文件字节，再通过一次目录重命名发布候选文件树、补丁、清单和回执。补丁保存替换内容和前置摘要，原文件中的删除字节留在隔离输入内。失败用例覆盖过期摘要、路径越界和 UTF-8 字符边界，并检查没有部分输出。 [字节与发布回归](https://github.com/MaLaNg116/itervane/blob/9d5bc2414d9342c8133eb4c8943e12aa4f4b0c9f/packages/runner/test/unit/guest-repair.test.ts)
3. 本地 Linux 严格类型检查及 127 项单元测试通过。维护者样例用固定提交的公开 README 在两份独立目录重放同一补丁，修改前后摘要与固定 Git 输入的独立计算结果相符。托管 KVM 验收脚本要求中英文回执都记录这些摘要和三类拒绝。此样例的托管 KVM 结果以及正式任务授权与 Runner 通道待验。 [离线客体样例](https://github.com/MaLaNg116/itervane/blob/0c4ad6cd80c8f2df167b8cfa451ea67d697356c8/packages/runner/src/guest-repair-fixture.ts#L13) · [原生验收脚本](https://github.com/MaLaNg116/itervane/blob/0c4ad6cd80c8f2df167b8cfa451ea67d697356c8/fixtures/runner/run-native-session.sh)

正式修复后续接入模板、修复 ReAct 及双语候选读面。P2-D3 使用独立环境复验补丁、扫描和平台基线，发布资格进入后续人工审批及执行核对。
