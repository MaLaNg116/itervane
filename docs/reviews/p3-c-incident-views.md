# P3-C3-D1 · 健康事件与关联任务的授权读面

接续 #129。读面固定为 `c46e5e4af3eb5db4b3ceec62be7441e260c5ab33`，集成用例固定为 `2ecbd28db68d7ead150c063a5ef173675e137de1`。 [实施计划](../plans/p3-c-incident-views.md) · [PR #130](https://github.com/MaLaNg116/itervane/pull/130)

1. 环境接口查询登记范围内的最新健康样本和事件历史。事件保留自己的最后样本，环境最新读数可以独立表示当前探针不可用。在同一 PostgreSQL 快照中读取事件、诊断状态和修复关联。 [事件契约](https://github.com/MaLaNg116/itervane/blob/c46e5e4af3eb5db4b3ceec62be7441e260c5ab33/packages/contracts/src/operations-incidents.ts) · [环境查询](https://github.com/MaLaNg116/itervane/blob/c46e5e4af3eb5db4b3ceec62be7441e260c5ab33/packages/control-plane/src/service/operations-incidents-view.ts#L83)
2. 任务读面从持久化诊断或修复关联回到同一事件，普通任务返回空关联。由项目读取权限和已登记环境控制访问。对外保留任务、发布和证据引用，并在中英文返回事件及健康说明。 [关联查询](https://github.com/MaLaNg116/itervane/blob/c46e5e4af3eb5db4b3ceec62be7441e260c5ab33/packages/control-plane/src/service/operations-incidents-view.ts#L98) · [HTTP 入口](https://github.com/MaLaNg116/itervane/blob/c46e5e4af3eb5db4b3ceec62be7441e260c5ab33/packages/control-plane/src/api.ts#L197)

TypeScript 和 PostgreSQL 17.12 用例通过。签名测试身份以项目查看者权限读取双语事件，核对故障、已恢复历史、随后探针不可用、关联任务、错误环境、错误项目及撤权。Whiskers 和部署回执由测试夹具提供。后续 C3-D2 接入正式确认、停止及外部 MCP，C3-D3 验收门户。 [真库用例](https://github.com/MaLaNg116/itervane/blob/2ecbd28db68d7ead150c063a5ef173675e137de1/packages/control-plane/test/integration/inspections.test.ts#L3379) · [托管检查](https://github.com/MaLaNg116/itervane/pull/130/checks)
