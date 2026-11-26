# P5-B1 · 空环境安装与真实身份

参考安装从全新目录和持久化卷开始。使用官方镜像的固定摘要、已有领域迁移及分开的运行和迁移账号。 [实施计划](../plans/p5-reference-install.md) · [双语安装说明](../reference-installation.md) · [#161](https://github.com/MaLaNg116/itervane/pull/161)

1. `c42405c` 生成私有安装目录，为控制面迁移和 Keycloak 分别配置数据库所有者，业务运行角色仅获已有 DML 权限。初始化只登记生成的维护者身份。API 和 Worker 各读自己的配置，避免从另一个安装继承连接和可选能力。 [Compose](https://github.com/MaLaNg116/itervane/blob/c42405c/packages/control-plane/ops/reference/compose.yml) · [安装与初始化](https://github.com/MaLaNg116/itervane/blob/c42405c/packages/control-plane/src/reference-installation.ts) · [启动入口](https://github.com/MaLaNg116/itervane/blob/c42405c/packages/control-plane/src/entries/reference.ts)
2. Keycloak 以固定 issuer 运行。门户和 MCP 分别登记自己的精确回调与 token audience，均要求 S256。导入的 owner 首次登录完成密码更换。MCP 的写 scope 单独申请，平台继续核对当前项目权限。 [参考 realm](https://github.com/MaLaNg116/itervane/blob/c42405c/packages/control-plane/src/reference-installation.ts)
3. `3342581` 使用真实 Compose PostgreSQL 17 与 Keycloak 26.8.2，两次执行初始化，再实际启动 API 和 Worker。Chrome 完成密码更换及中英文任务显示，MCP 通过独立授权码和 PKCE 读回同一任务。用 MCP 凭据访问普通 API 被拒，查询凭据的工具目录没有写入口，任务等待合格 Runner。 [浏览器与 MCP 验收](https://github.com/MaLaNg116/itervane/blob/3342581/packages/portal/test/native/reference-install.ts) · [托管入口](https://github.com/MaLaNg116/itervane/blob/3342581/.github/workflows/verification.yml)

本地严格类型、287 项单测、门户打包和干净安装演练通过。镜像从各自官方仓库按固定摘要获取。身份及回调测试使用新建的真实 Keycloak realm。参考控制面默认绑定本机回环，整合 KVM、模型、发布、运维和规则复用属于下一批发布验收范围。 [固定 hostname](https://www.keycloak.org/server/hostname) · [启动时导入 realm](https://www.keycloak.org/server/importExport)
