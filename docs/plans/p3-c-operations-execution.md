# P3-C2 · 受控处置与恢复验证

基于门户审批 #85。继续使用同一发布环境、全局执行槽、固定的已核验发布及当前授权。 [处置总计划](p3-c-operations-proposals.md) · [前置 PR](https://github.com/MaLaNg116/itervane/pull/85)

| 批次 | 交付与验收 |
| --- | --- |
| C2a 原生重启协议 | 固定 Whiskers 版本、来源、凭证用途与全长容器 ID。首次调用只接受新待批回执，恢复调用核对此前的批准 ID。任何无法确认的写响应进入结果未知。真实 Whiskers 核对暂停、批准、目标和只执行一次，再独立验证恢复。 |
| C2b 派发和占用 | 在同一环境锁下保存确认版本、批准者与提交者授权、目标和动作指纹。记录发送意图再调用下游，暂停前释放全局执行槽并保持必要的环境占用。验收重复唤醒、撤销、过期、新版本冲突和接管。 |
| C2c 重启结算 | 续发前再次核对原生批准、当前发布、有效授权和执行权。用独立容器及受保护入口验证恢复。响应丢失只回读，按实证结算或留下人工核对与资源占用。 |
| C2d 版本恢复 | 用 Komodo 恢复提案指定的已发布版本，复用固定镜像、更新读回、入口保护与健康核验。使后续诊断读取恢复后的真实发布，覆盖失败与结果未知。 |

Whiskers 0.15 的原生许可绑定调用者、工具及完整参数。原生批准 ID 出现在首次回执和待批回执，续发成功只返回重启应答。参考安装应验证原生 Confirm 策略，以专用 Write 凭证提交固定重启。平台持久化关联该凭证、批准 ID 与提案，只允许同一绑定存在一个未结算的原生申请。未知、撤销或原生批准换号时保留核对记录，待确认旧授权已失效后再开放同一绑定。审批使用下游人工界面。 [原生确认实现](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/src/Whiskers/Services/Agent/Guardrails/DirectMcpCallGuard.cs) · [重启工具来源](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/src/Whiskers/Mcp/Tools/ContainerTools.cs)

C2a 验收适配器与真实原生工具的交互。正式运维写能力由后续持久化派发、安装态策略和恢复验证一道启用。
