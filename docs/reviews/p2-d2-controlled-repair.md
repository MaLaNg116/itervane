# P2-D2 · 受控修复导读

本批以 #22 已合入 main 的正式审计为基线。首项交付固定修复交接输入，供合格 Runner 重建对应源码。 [草稿 PR #23](https://github.com/MaLaNg116/itervane/pull/23) · [实施计划](../plans/p2-d2-controlled-repair.md)

## D2.1 固定修复交接

1. 正式审计成功时，Worker 在同一事务保存修复输入、审计结果和任务事件。修复输入引用当前任务的提交、代次、检查计划、扫描回执、已发布审计检查点、发现编号及目录摘要。模型故障、部分扫描和待核对的审计继续使用原有人工路径。 [审计入库](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/src/service/formal-audit.ts#L83) · [交接契约](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/contracts/src/formal-repair.ts)
2. 重领后以同一运行的正式审计重新计算摘要，验证已保存的记录。已有完整审计而缺少交接记录时，可在当前授权租约中按原证据准备。迁移只添加交接表和当前执行权约束，数据库核对当前 run、执行权、来源、扫描、目录和实际发现清单。行一经保存即保留。 [交接服务](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/src/service/formal-repair.ts#L10) · [迁移约束](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/migrations/0015_formal_repair_inputs.sql#L15)
3. 本地通过 123 项单元测试和 102 项 PostgreSQL 集成测试，其中源码与审计专项 24 项。专项覆盖成功审计后的交接、模型失败、事务回滚、重领复用、按旧审计准备、不同运行或过期执行权拒绝、快照替换及历史不可变。测试用独立数据库为重领场景安排新的租约。 [数据库回归](https://github.com/MaLaNg116/itervane/blob/46ade9770524a47a712dd7ce1da988cfae88530e/packages/control-plane/test/integration/inspections.test.ts#L432)

## D2.2 结构化补丁和候选目录

1. 补丁契约固定原文件摘要和 UTF-8 字节区间，并限制文件数量、修改次数及替换字节数。客体从已验证的只读快照取得原始字节，再核对仓库、提交、清单、授权路径以及原文件摘要。保留未修改的内容与文件模式。 [补丁与工作区契约](https://github.com/MaLaNg116/itervane/blob/9d5bc2414d9342c8133eb4c8943e12aa4f4b0c9f/packages/contracts/src/formal-repair.ts) · [客体实现](https://github.com/MaLaNg116/itervane/blob/9d5bc2414d9342c8133eb4c8943e12aa4f4b0c9f/packages/runner/src/guest-repair.ts#L78)
2. 写入独立暂存目录，逐个校验实际文件字节，再通过一次目录重命名发布候选文件树、补丁、清单和回执。补丁保存替换内容和前置摘要，原文件中的删除字节留在隔离输入内。失败用例覆盖过期摘要、路径越界和 UTF-8 字符边界，并检查没有部分输出。 [字节与发布回归](https://github.com/MaLaNg116/itervane/blob/9d5bc2414d9342c8133eb4c8943e12aa4f4b0c9f/packages/runner/test/unit/guest-repair.test.ts)
3. 本地 Linux 严格类型检查及 127 项单元测试通过。维护者样例用固定提交的公开 README 在两份独立目录重放同一补丁，修改前后摘要与固定 Git 输入的独立计算结果相符。托管 KVM 在 `e899b8f` 产生的两份中英文回执记录相同的补丁与候选清单摘要、原文件保留、三类拒绝及域清理。 [离线客体样例](https://github.com/MaLaNg116/itervane/blob/0c4ad6cd80c8f2df167b8cfa451ea67d697356c8/packages/runner/src/guest-repair-fixture.ts#L13) · [原生验收及产物](https://github.com/MaLaNg116/itervane/actions/runs/44793982376)

## D2.2 合格 Runner 的修复通道

1. TS 客户端将规范化补丁与受信工作区编码为有界命令。请求头固定任务、run、代次、fence、操作、原始快照和命令的字节摘要。Unix 控制器检查对端 UID、工作区与登记来源，显式启用修复后等到首个授权心跳，再读取正文，核对字节数、摘要、操作和固定来源。现有 libvirt 锁覆盖一次执行。 [客户端入口](https://github.com/MaLaNg116/itervane/blob/6bf15e97cf06628246580e282b542f33e93eedbc/packages/runner/src/qualified-client.ts#L160) · [控制器准入](https://github.com/MaLaNg116/itervane/blob/4148091007ef31d6009829140b0801ba6b8d1a67/packages/runner/host/qualified_controller.py#L226)
2. 客体获取固定 Git 树、关闭取源出口并核对对象后接收修复命令。封存执行身份从只读目录读取正文和原快照，生成私有候选并返回绑定摘要。控制器在确认域、QEMU 和暂存已回收后交付结果。客户端再次核对 fence、命令、补丁及每个文件的变更摘要和大小。 [宿主和客体协议](https://github.com/MaLaNg116/itervane/blob/6bf15e97cf06628246580e282b542f33e93eedbc/packages/runner/host/native_source.py) · [离线修复入口](https://github.com/MaLaNg116/itervane/blob/6bf15e97cf06628246580e282b542f33e93eedbc/packages/runner/src/guest-repair.ts#L101)
3. 本地 Linux 的 128 项 TypeScript 单元测试、严格类型检查和 41 项宿主 Python 测试通过。托管验收复用同一真实扫描的源码摘要，检查首个心跳拒绝、过期文件摘要与清理，以及有效补丁从 391 字节变为 436 字节的准确指纹。该入口使用独立的维护者验证进程，正式 Worker 的 PostgreSQL 操作预留与结果发布待接入。 [合格通道原生样例](https://github.com/MaLaNg116/itervane/blob/bc23202bac876885a4a519eafd980df6676d6e26/scripts/probe-qualified-runner.ts#L22) · [本批检查](https://github.com/MaLaNg116/itervane/pull/23/checks)

正式修复后续接入模板、修复 ReAct 及双语候选读面。P2-D3 使用独立环境复验补丁、扫描和平台基线，发布资格进入后续人工审批及执行核对。
