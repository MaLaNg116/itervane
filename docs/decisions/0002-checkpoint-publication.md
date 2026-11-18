# ADR 0002：领域发布检查点与执行权 fencing

- 状态：P1-B 实施采用。
- 约束：LangGraph 提供恢复基础；领域事实、当前权限和执行权是权威依据。

## 决定

PostgresSaver 仍负责其内部 schema、序列化和图检查点。运行时包装 saver 的读写：校验逻辑 run 和当前全局 fence，在短事务内锁定执行权，完成 checkpoint 数据写入后再次检查租约/取消条件，再把具体 checkpoint ID 发布到领域 runtime 记录。

底层 checkpoint 和领域指针不是一个分布式原子事务。进程可能在 checkpoint 已写入、领域指针未提交时崩溃。因此恢复只读取领域已发布 ID，绝不默认选择底层 latest；多余未发布 checkpoint 不获得执行资格。旧 Worker 失去 fence 后不能继续发布指针、工具结果或新的工具调用。

锁只覆盖 checkpoint 的数据库写入与领域发布，不覆盖图节点、模型调用、工具执行或人工等待。checkpoint 保存失败或租约失效时拒绝本次发布，由重领后的执行者重新核对。pending writes 同样经 fencing 包装，且不携带批准或基础设施凭证。

pending writes 另有领域发布回执：按 saver 序列化后的 `(taskId, channel, value)` 计算哈希，和领域事务一起提交。恢复保留底层排序，但过滤没有回执的中间写入。这样即使底层 putWrites 已提交、领域事务随后回滚，也不会借已发布 checkpoint 注入未发布的中间结果。丢失或被覆盖的中间结果可以重算；工具账本仍负责避免重复扣预算，未来有副作用的工具必须另走 operation ledger，不能依赖 checkpoint 达到 exactly-once。

逻辑 run ID 与 generation 保持领域含义；每次领取/恢复都有新 slot fence。检查点恢复不会复活旧 fence。暂停/等待子任务时释放 slot，恢复重新竞争并检查当前权限、取消状态和剩余预算。

## 验证

测试必须包含真实 PostgresSaver interrupt/resume、过期执行者拒写、底层已写但指针未发布的故障窗口，以及新 Worker 仅从已发布 ID 恢复。检查点不存在但任务已被接受时，从正式任务输入重建 preflight；不能丢弃任务或冒充已执行。
