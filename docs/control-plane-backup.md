# 控制面冷备与恢复

使用 PostgreSQL 17 服务端和同一主版本的 `psql`、`pg_dump`、`pg_restore`。备份包括 Itervane 领域数据及规则历史、迁移账本、pg-boss 队列、LangGraph 检查点、数据库引用的 Runner OCI 档案，以及维护者选定的安装配置。对应环境的数据库与产物需要从同一次冷备恢复。 [P5-A 计划](plans/p5-backup-restore.md) · [PostgreSQL 导出](https://www.postgresql.org/docs/17/app-pgdump.html) · [PostgreSQL 恢复](https://www.postgresql.org/docs/17/app-pgrestore.html)

## 导出

1. 停止访问该库的 API、Worker、运维消费者和迁移进程。让正在运行的 Runner 作业关闭，冻结归档和配置目录的写入。目标应用继续使用它原有的受保护入口。
2. 收集需要恢复的普通配置文件到独立目录。目录允许字母、数字、点、下划线、连字符，名称以字母或数字开头。受管凭证单独保留。使用具备四个应用 schema 读取权限的维护账号，通过 libpq 环境与 `PGPASSFILE` 连接源库。
3. 指定一个全新的、位于私有存储的输出目录。第二个参数是 Runner 的受保护 OCI 档案目录，第三个参数是本次选定的配置目录。

```sh
export PGHOST=postgres.example
export PGPORT=5432
export PGDATABASE=itervane
export PGUSER=itervane_migrator
export PGPASSFILE=/run/secrets/pgpass
pnpm backup:export /mnt/private/itervane-backup /var/lib/itervane/artifacts /mnt/private/installation-config
```

成功时目录中有 `database.dump`、`artifacts/`、`configuration/` 和最后写入的 `manifest.json`。清单记录各表行数和比较校验值、每个文件的字节数和 SHA-256。私下保存整组文件和对应发布版本。独立管理 Keycloak、Komodo、Whiskers、Registry、凭证存储和目标应用的数据。

## 恢复

1. 使用受信备份及 PostgreSQL 17 新环境。创建由迁移维护角色所有的独立空库，运行账号在验证前保持断开。把 libpq 环境改为恢复端。
2. 指定一个全新的文件恢复目录。命令核对备份文件，检查目标空库，将归档和配置复制到新目录，再以单事务恢复数据库并核对清单。成功后目录中有 `restore-receipt.json`。

```sh
export PGHOST=postgres-recovery.example
export PGDATABASE=itervane_recovered
pnpm backup:restore /mnt/private/itervane-backup /mnt/private/itervane-recovered
```

3. 让专用 Runner 用户拥有已恢复的 `artifacts/`，目录权限为 `0700`，档案为 `0400`。管理员按安装文档授予运行账号权限，为相同版本安装配置和受管凭证。 [运行账号权限](control-plane-p1-a.md)
4. 用目标下游的当前状态核对待处理发布、重启与版本恢复。版本、审批和执行结果有疑问时，按持久化的取消、失效、对账或人工接管路径处理。核对过的环境才可连接写入 Worker。回执中的 `reconciled: false` 记录本步骤待办。

失败会返回非零退出码。没有清单的目录是未成功完成的导出。没有恢复回执的目标应留在隔离状态。查明失败后，重试使用独立的空目标和新输出目录。日志可用于定位失败阶段，备份内容只在受控维护环境读取。

## English

Use the PostgreSQL 17 client tools. Stop the API, all consumers, migrations and Runner writes to the source database, archive directory and selected installation files, then run `pnpm backup:export <new-backup-directory> <runner-archives> <selected-configuration>`. Supply the connection using libpq variables and a managed password file. Keep the complete bundle in private storage with its Itervane version. Back up the external services and application state through their own procedures.

Point libpq at a separate empty recovery database owned by the maintenance role and run `pnpm backup:restore <backup-directory> <new-recovery-directory>`. The command verifies the files, restores the database in one transaction and checks its inventory. Keep consumers disconnected until the restoration receipt exists. Reprovision the runtime grants, Runner file ownership, deployment configuration and managed credentials, and reconcile active downstream state and outstanding effects before enabling writers. [PostgreSQL libpq variables](https://www.postgresql.org/docs/17/libpq-envars.html)
