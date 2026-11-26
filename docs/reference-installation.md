# 参考安装

这套安装在一台主机上启动通用 Itervane 控制面和双语门户，使用独立的 PostgreSQL 角色和实际 Keycloak。API、身份和数据库监听本机回环。需要 Node.js 24、pnpm 11.9.0 与 Docker Compose。 [实施计划](plans/p5-reference-install.md)

## 首次安装

从固定的 Itervane 版本检出，预留 5432、8380、4310 和 4862 四个本机端口。生成目录包含安装凭证，请选私有位置并保留生成的目录权限。

```sh
reference_dir="$HOME/.local/state/itervane/reference"
install -d -m 0700 "$(dirname "$reference_dir")"
pnpm install --frozen-lockfile --ignore-scripts
pnpm build:portal
pnpm reference:prepare "$reference_dir"
docker compose --project-directory "$reference_dir" --env-file "$reference_dir/.env" \
  -f "$reference_dir/compose.yml" up --detach --wait
pnpm reference:init "$reference_dir"
```

生成目录须是新目录。需要调整端口时，执行 `pnpm reference:prepare <目录> <数据库端口> <身份端口> <门户端口> <MCP 回调端口>`。请使用本次生成的 Compose 项目，确保当前 shell 中的 Compose 项目名和端口变量匹配。

PostgreSQL 用持久化卷承载平台和 Keycloak 的两个数据库。初始化先用专用迁移账号应用迁移，授予运行角色现有 DML 权限，再按真实 realm 的 issuer 与生成的 subject 登记 owner。重复初始化保留已有身份和业务记录。 [角色权限](control-plane-p1-a.md) · [Keycloak realm 导入](https://www.keycloak.org/server/importExport)

## 启动与验证

在两个终端分别运行以下命令，或以相同作用域交给本机服务管理器。

```sh
pnpm reference:start "$reference_dir" api
pnpm reference:start "$reference_dir" worker
```

API 和 Worker 从各自的环境文件读取配置。以 `reference:init` 返回的门户地址打开 Chrome。在私有的 `owner-login.env` 查初始维护者账号和口令，通过 Keycloak 登录并更新初始口令。门户和身份服务由固定 origin、回调路径、API audience 和 PKCE S256 绑定。 [Keycloak hostname](https://www.keycloak.org/server/hostname) · [浏览器身份边界](control-plane-p1-c.md)

1. 创建项目，登记公开的 HTTPS 仓库，提交固定 Git 版本并查看任务事件。未接入合格 Runner 的任务进入等待。
2. 在外部 MCP 客户端预登记 `reference:init` 输出的客户端 ID 与回调。走授权码加 PKCE，申请 `itervane:read`。读回同一任务及检查状态。写操作使用显式申请的 `itervane:write`，并继续核对项目权限。
3. 接入执行宿主、验证配置及模型后可启用实际审计和复验。按发布步骤登记 Komodo、Registry 和受保护应用入口，再配置运维环境中的 Whiskers。 [参考 KVM Runner](reference-runner-installation.md) · [受保护发布](reference-release-installation.md) · [运维环境](control-plane-restart.md)

控制台仅监听本机回环。需要团队访问时，使用受保护的 HTTPS 入口和正式 Keycloak issuer，按安装说明配置确切的回调、网站来源、访问令牌和代理日志策略。暂停 Compose 服务会保留数据库卷。升级前使用冷备流程。 [冷备恢复](control-plane-backup.md)

## 升级既有参考安装

适用于参考安装中的 PostgreSQL 17 和同一 Keycloak realm。保留生成的安装目录、回环端口、数据库卷和身份配置。

1. 暂停 API、Worker 和各专用执行进程。让活动的 Runner 作业结束。保存源版本、数据库、OCI 档案和配置冷备，并单独保留 Keycloak 与受管凭证。 [冷备恢复](control-plane-backup.md)
2. 检出目标版本，执行 `pnpm install --frozen-lockfile --ignore-scripts` 和 `pnpm build:portal`。确保原 PostgreSQL 与 Keycloak 服务可访问。在新 checkout 中对原安装目录运行 `pnpm reference:init "$reference_dir"`。初始化核对已应用迁移的哈希、执行新增迁移、更新运行角色权限，并使用原 Keycloak subject。重复初始化可核对迁移账本稳定。
3. 恢复 API 和 Worker，使用原维护者登录并查看旧任务。核对仍待处理的任务、规则、档案引用和下游实际状态。完成未决操作核对后，再启用相应写入 Worker。 [冷备中的恢复核对](control-plane-backup.md#恢复)
4. 如果迁移或应用验证失败，保持执行进程暂停。在独立空恢复环境中恢复升级前冷备，再以该冷备对应的代码版本和原有访问范围启动。

## English

Use Node.js 24, pnpm 11.9.0 and Docker Compose. From a pinned checkout, install the locked dependencies, build the portal and run `pnpm reference:prepare <new private directory>`. Start the generated Compose project, then use `pnpm reference:init <directory>` to apply migrations, grant runtime access and initialize the owner on the real Keycloak realm.

Run `pnpm reference:start <directory> api` and `pnpm reference:start <directory> worker` separately. The portal, PostgreSQL and Keycloak are loopback-bound. Sign in with the initial owner credentials stored in the private directory, and set a new password. Register an HTTPS repository, submit a fixed revision and read the task through the pre-registered MCP Authorization Code + PKCE client. The MCP token has its own resource audience and scopes. Execution becomes available after a qualified Runner and the required integrations are installed.

To upgrade an existing reference installation, keep the same PostgreSQL 17 data, Keycloak realm and private configuration. Stop the API and workers, finish active Runner jobs and take a cold backup. Check out the target version, install its locked dependencies and build the portal. Run `pnpm reference:init <existing-directory>` to validate the migration history, apply new migrations and refresh runtime grants. Start the API and worker and verify the original owner and existing tasks. Reconcile unresolved downstream effects before enabling effect writers. If the upgrade fails, restore the pre-upgrade backup to a separate empty environment and start it with the matching code version. [Backup and recovery](control-plane-backup.md#english)
