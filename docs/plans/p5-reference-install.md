# P5-B1 · 从空环境安装参考控制面

这一批先交付可重复的控制面安装。参考主机使用 Node.js 24、锁定的 pnpm、PostgreSQL 17 和真实 Keycloak。优先复用已有的域迁移、角色授权、API、双语门户、Worker 和 MCP。 [P5 验收](../implementation-plan-v2-ts-postgresql.md#p5-验证可靠性并形成可复现的开源交付) · [#161](https://github.com/MaLaNg116/itervane/pull/161)

1. 在维护者私有目录生成独立 Compose 实例，锁定 PostgreSQL 和 Keycloak 镜像。区分迁移、运行、IdP 数据库账号和初始维护者。只在本机回环开放控制面依赖。
2. 固定 Keycloak issuer，分别配置门户和外部 MCP 的 OIDC audience、精确回调和 PKCE S256。引导首次登录轮换初始口令。迁移和首次 owner 登记走原有命令和权限，重复初始化保留已有所有者和数据。
3. 通过参考安装实际启动两个基础服务及 API 和 Worker，使用真实 Chrome 登录，在双语门户提交固定版本任务，再用独立授权的 MCP 客户端读回。尚未连入执行宿主的任务须按原闸门暂停。
4. 后续在同一安装路径上接入一次性 KVM Runner、镜像 Registry、受保护入口、Komodo 与 Whiskers，完成三条闭环与独立重复运行。此批冷启动证据覆盖基础控制面和身份，发布验收仍依赖后续原生运行、故障回归和备份恢复。
