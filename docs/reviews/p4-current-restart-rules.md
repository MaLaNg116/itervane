# P4-D4b · 运维规则变更后的重启与对账

本批核对任务接收时的运维规则与当前活动版本。规则发布、撤回和回滚都能使相关旧呈批失效。 [实施计划](../plans/p4-current-restart-rules.md) · [#157](https://github.com/MaLaNg116/itervane/pull/157)

1. `32b01a0` 在原重启授权入口比较当前规则，旧空集合也包含在判断范围内。迁移 `0083` 约束新提议、确认、发送意图和实际续办准备。 [当前规则核对](https://github.com/MaLaNg116/itervane/blob/32b01a0/packages/control-plane/src/service/operations-proposals.ts) · [数据库约束](https://github.com/MaLaNg116/itervane/blob/32b01a0/packages/control-plane/migrations/0083_current_restart_rule_authority.sql)
2. `0e97777` 领取队列时使用全局槽关闭失效的未发请求。已有原生审批或尚需确定实际效果时，旧执行停止写入，守住环境占用并开始只读对账。状态记录包含双语原因。 [领取和对账](https://github.com/MaLaNg116/itervane/blob/0e97777/packages/control-plane/src/runtime/operations-execution-lease.ts)
3. `3d12ac9` 通过 PostgreSQL 验证首次 Runbook 发布后旧空集合提议不可用、排队重启关闭和等待原生审批转只读核验。验证审批续办拒绝、无新发送、历史诊断一致，以及环境在结果未知时仍被占用。 [真库回归](https://github.com/MaLaNg116/itervane/blob/3d12ac9/packages/control-plane/test/integration/inspections.test.ts)

TypeScript、287 项单测、Drizzle 检查和 PostgreSQL 17.12 上的 6 项专项通过。后端使用受控 Anthropic 适配器及 Whiskers 回执夹具。真实原生重启、规则复用和中断回执见已合入的 #156。 [真实 Whiskers 验收](p4-native-runbook-reuse.md)
