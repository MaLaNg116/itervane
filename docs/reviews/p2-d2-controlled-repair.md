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
3. 本地 Linux 的 128 项 TypeScript 单元测试、严格类型检查和 41 项宿主 Python 测试通过。托管 KVM 的 `59eeb5b` 产物确认独立维护者进程复用同一真实扫描的源码摘要。首个心跳被拒时没有域启动，过期文件摘要在客体中被拒并完成回收，有效补丁从 391 字节变为 436 字节且指纹吻合。 [合格通道原生样例](https://github.com/MaLaNg116/itervane/blob/bc23202bac876885a4a519eafd980df6676d6e26/scripts/probe-qualified-runner.ts#L22) · [原生验收及产物](https://github.com/MaLaNg116/itervane/actions/runs/44796998891)

## D2.2 Worker 的操作预留和回执

1. 修复执行服务从同一 run 的审计交接与已登记扫描重建依据。选中的发现限定可编辑文件，npm 锁文件发现可关联同目录的包清单，独立策略传入受保护路径。调用键固定唯一操作和实际补丁。PostgreSQL 检查 UTF-8 命令摘要、审计来源、当前任务与执行权。 [操作预留](https://github.com/MaLaNg116/itervane/blob/98db393dcb059eef516c3e7a7a293e2b20148f74/packages/control-plane/src/runtime/repair-execution.ts#L150) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/98db393dcb059eef516c3e7a7a293e2b20148f74/packages/control-plane/migrations/0016_formal_repair_execution.sql#L61)
2. 派发记录绑定操作、工作区、镜像和 fence。每次心跳及回执入库都复查当前授权和预留。回执须与原扫描记录的提交对象 SHA-256、Git 树及文件数一致。重领时在经核对的原工作区重放原操作，未知结果保留待核对，重复成功直接读取已验回执。 [授权与结算](https://github.com/MaLaNg116/itervane/blob/98db393dcb059eef516c3e7a7a293e2b20148f74/packages/control-plane/src/runtime/repair-execution.ts#L209)
3. 本地通过 107 项真实 PostgreSQL 回归，其中源码、审计与修复专项 29 项，另通过 Linux 严格类型检查和 128 项单元测试。数据库用例覆盖并发重复调用、补丁替换、不在证据内的修改、假回执、取消、撤权及旧租约重领。托管 KVM 在 `7b3a192` 使用 PostgreSQL 17.12 和独立测试 Worker 接续真实审计。样例从 158 字节变为 38 字节，两个摘要与独立计算一致。原始快照一致、来宾域回收、单次落库和重复回执复用均已核对。 [数据库回归](https://github.com/MaLaNg116/itervane/blob/98db393dcb059eef516c3e7a7a293e2b20148f74/packages/control-plane/test/integration/inspections.test.ts#L204) · [联合原生验收](https://github.com/MaLaNg116/itervane/actions/runs/44800418318)

## D2.3 修复文件观测与检查点

1. Worker 从已发布的审计发现推导目标，沿用 npm 锁文件关联包清单的规则，每次请求最多观察八个目标。观测使用单独的 Unix 请求与客体消息。客体重新核验固定快照，在只读挂载上计算原文件摘要、长度及审计行的 UTF-8 字节区间。受保护路径返回状态。单行 dotenv 赋值可返回版本化模板提示，原始行内容留在客体。 [目标权限](https://github.com/MaLaNg116/itervane/blob/68242aa41824c4aacee86ab09988a8ece7a12ce9/packages/control-plane/src/runtime/repair-observation.ts#L20) · [客体计算](https://github.com/MaLaNg116/itervane/blob/8d8ef692c10b7db85e326981e5f6a837a08fc5d7/packages/runner/src/guest-repair-observation.ts#L34)
2. 回执必须绑定本次读请求、原扫描对象、目标和实际回收。复用测试 Worker 增加一轮真实文件观测。由审计行选择观测区间，核对预先计算的字节指纹，再用返回的文件长度和摘要构造固定样例补丁。最新提交通过 129 项 Linux 单元测试、42 项宿主测试和 109 项真实 PostgreSQL 回归。托管观测样例待取得新运行产物。 [观测到补丁的原生样例](https://github.com/MaLaNg116/itervane/blob/116b0bef53320851702cb0436dc24addb795bb9d/packages/control-plane/test/native/worker-repair.ts#L15)
3. 修复图使用单独的 LangGraph 线程与领域发布指针。指针绑定认领的 run、输入摘要、Worker 和 fence。恢复只读取已发布的修复检查点及其已确认中间写入。真实 PostgreSQL 用例覆盖与审计线程隔离、错误输入、未确认写入和旧 Worker 被拒。 [检查点实现](https://github.com/MaLaNg116/itervane/blob/78464c79a080e8cb5a266f6a1191f5cd4bed1a37/packages/control-plane/src/runtime/checkpointer.ts#L18) · [恢复用例](https://github.com/MaLaNg116/itervane/blob/78464c79a080e8cb5a266f6a1191f5cd4bed1a37/packages/control-plane/test/integration/inspections.test.ts#L741)

下一批接入修复 ReAct 的模板选择、结构化编辑和业务队列接续，再发布双语候选读面。P2-D3 使用独立环境复验补丁、扫描和平台基线，发布资格进入后续人工审批及执行核对。
