# 门户组件迁移与运行

现行门户使用 React、Vite、shadcn/ui（Base UI）和 Tailwind CSS。部署沿用 [P1-C 的 OIDC 配置](control-plane-p1-c.md)。登录、项目、任务详情、规则和预审报告继续提供 en 与 zh-CN，GSAP 延续 [P1-UX 的动效设计](portal-design-motion.md)。

## 升级

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:portal
# 停止原 API 再启动，使其载入新构建的静态资源
pnpm start:api
```

保留构建目录中的 `third-party-licenses.md` 和 `shadcn-LICENSE.txt`。运行入口仍只提供同源构建资源，Base UI 读取服务器生成的页面 nonce。回退时使用 [#7 基线](https://github.com/MaLaNg116/itervane/pull/7) 的代码和锁文件重新构建并重启 API。本批没有数据库迁移。

## 维护

项目拥有 `packages/portal/src/ui` 下的组件源码，更新方式见[固定上游来源和第三方许可](third-party-ui.md)。在 `style.css` 维护色板，`ui/tailwind.css` 将其映射到组件 token。Tailwind 只编译源码中使用的类，省略 Preflight。新增产品文案放进 `messages.ts`，并在双语浏览器路径中检查长文案和窄屏。

表单错误存翻译键。预审切换显示语言时，同项目和同会话的目录摘要用于保持表单挂载，规则文本在相应语言响应到达后展示。提交仍校验目录摘要、输入上限与项目权限；请求结果不确定时使用原请求重试。状态、Runner 未就绪和报告覆盖范围展示都来自既有 API。

通过 `pnpm check`、`pnpm test:integration` 和 `pnpm test:portal` 验证。浏览器使用本地真实 OIDC、PostgreSQL、Worker 与 Chrome，测试资源和截图存放于忽略目录 `.reports/`。具体阶段、固定源码和回归证据见[迁移导读](reviews/p1-ux-shadcn-migration.md)。
