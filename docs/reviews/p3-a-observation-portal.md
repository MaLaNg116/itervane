# P3-A2-C3 · 双语容器观察门户导读

依赖 [诊断接入 #72](https://github.com/MaLaNg116/itervane/pull/72)。发布作用域与任务类型固定于 `1a22d2d0c2c468b40917a89e9b12addcd3fbbd0a`，门户与浏览器用例固定于 `60182114d28758251f24f7b3ad0fa797db86e8aa`。 [分批计划](../plans/p3-a-observation-portal.md)

1. 只有当前项目写入者可为当前有效的已核验发布查询启动选项。选项复用已发布证据和安装登记校验。提交使用选项绑定的发布操作 ID，在入队事务内重新检查。原键重放保留已经受理的版本。当前 run 的持久化角色决定任务类型，现有交付任务响应保持兼容。 [选项入口](https://github.com/MaLaNg116/itervane/blob/1a22d2d0c2c468b40917a89e9b12addcd3fbbd0a/packages/control-plane/src/api.ts#L176) · [事务接收](https://github.com/MaLaNg116/itervane/blob/1a22d2d0c2c468b40917a89e9b12addcd3fbbd0a/packages/control-plane/src/service/tasks.ts#L88)
2. 双语发布详情只在当前选项与可见发布一致时提供观察按钮。切换显示语言保留原请求键和提交语言。任务接收成功后只在原任务页仍打开时跳转。诊断页沿用授权和任务事件，显示观察时间、容器状态、原因与回执摘要。状态和证据披露沿用 GSAP 与无动效偏好。 [观察按钮与回执](https://github.com/MaLaNg116/itervane/blob/60182114d28758251f24f7b3ad0fa797db86e8aa/packages/portal/src/pages/task-operations.tsx#L13)

本机 TypeScript 与 211 项单元检查通过。独立 PostgreSQL 17.12 三项专项通过，覆盖发布操作不符、后端换绑、授权收回以及新旧任务列表。真实 Chrome、Keycloak 与 PostgreSQL 的观察门户专项和三项发布详情回归通过。观察专项在浏览器中使用受控发布和回执，实际任务及项目读取走真实授权。已发布容器的原生 Whiskers 读取沿用 #71 证据。 [浏览器专项](https://github.com/MaLaNg116/itervane/blob/60182114d28758251f24f7b3ad0fa797db86e8aa/packages/portal/test/browser/portal.spec.ts#L502) · [原生观察验收](https://github.com/MaLaNg116/itervane/actions/runs/44968006971/job/137041290751)
