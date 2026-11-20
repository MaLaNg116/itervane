# P2-D2 · 受控修复导读

本批以 #22 的正式审计为基线。首项交付固定修复交接输入，供合格 Runner 重建对应源码。 [草稿 PR #23](https://github.com/MaLaNg116/itervane/pull/23) · [实施计划](../plans/p2-d2-controlled-repair.md)

## D2.1 固定修复交接

1. 正式审计成功时，Worker 在同一事务保存修复输入、审计结果和任务事件。修复输入引用当前任务的提交、代次、检查计划、扫描回执、已发布审计检查点、发现编号及目录摘要。模型故障、部分扫描和待核对的审计继续使用原有人工路径。 [审计入库](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/src/service/formal-audit.ts#L83) · [交接契约](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/contracts/src/formal-repair.ts)
2. 重领后以同一运行的正式审计重新计算摘要，验证已保存的记录。已有完整审计而缺少交接记录时，可在当前授权租约中按原证据准备。迁移只添加交接表和当前执行权约束，数据库核对当前 run、执行权、来源、扫描、目录和实际发现清单。行一经保存即保留。 [交接服务](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/src/service/formal-repair.ts#L10) · [迁移约束](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/migrations/0015_formal_repair_inputs.sql#L15)
3. 本地通过 123 项单元测试和 102 项 PostgreSQL 集成测试，其中源码与审计专项 24 项。专项覆盖成功审计后的交接、模型失败、事务回滚、重领复用、按旧审计准备、不同运行或过期执行权拒绝、快照替换及历史不可变。测试用独立数据库为重领场景安排新的租约。 [数据库回归](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/test/integration/inspections.test.ts#L432)

现有任务保持等待修复。补丁契约、合格工作区、两种修复路径和候选读面按后续切片验收。P2-D3 接入独立复验，发布资格在后续审批和执行阶段核对。
