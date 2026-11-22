# 自托管指定版本恢复

指定版本恢复适用于已登记的受保护应用。治理平台冻结提案和批准，Komodo 执行获批的镜像恢复，独立读身份核对原生更新、实际容器和入口健康。门户提供本人确认与提交，外部 MCP 提供诊断与回执查询。 [阶段计划](plans/p3-c-operations-restore.md)

## 准备环境

1. 完成数据库迁移、门户登录与受保护发布。在同一发布登记下保留可恢复的已核验镜像和发布回执。 [门户安装](control-plane-p1-c.md) · [受保护入口](../fixtures/ingress/reference/README.md) · [发布安装](reviews/p2-e-release-installation.md)
2. 核对环境 UUID、当前运维登记指纹、发布目标指纹及正式诊断模型指纹。配置对应的 Whiskers 只读诊断 Worker。 [正式诊断安装](reviews/p3-b-operations-diagnosis-installation.md)
3. 为 Restore Worker 准备已登记的 Komodo 部署写身份，另建同一部署的非管理员 `Read` 与 `Inspect` 身份。沿用已登记入口的 Keycloak 健康探针，给 Restore Worker 提供其密钥。 [凭证与安装范围](reviews/p3-c-installed-restore-worker.md)

## 配置并启动

API 启用恢复时使用下列配置，并保留现有身份和数据库配置。示例环境文件列出了 Worker 所需的各项变量。 [配置示例](../.env.example)

| 进程 | 恢复相关配置 |
| --- | --- |
| API | `ITERVANE_RESTORE_API_ENABLED=1`、`ITERVANE_OPERATIONS_API_ENABLED=1`、真实的 `ITERVANE_PORTAL_CLIENT_ID`、`ITERVANE_OPERATIONS_DIAGNOSIS_PROVIDER_SHA256`、环境 UUID、运维登记与发布目标指纹。 |
| 诊断 Worker | 同一环境和运维登记指纹、模型协议配置与 Whiskers Read 凭证。 |
| Restore Worker | 同一环境 UUID、运维登记与发布目标指纹，以及 `ITERVANE_RESTORE_KOMODO_WRITER_KEY`、`ITERVANE_RESTORE_KOMODO_WRITER_SECRET`、`ITERVANE_RESTORE_KOMODO_READER_ID`、`ITERVANE_RESTORE_KOMODO_READER_KEY`、`ITERVANE_RESTORE_KOMODO_READER_SECRET`、`ITERVANE_RESTORE_PROBE_SECRET`。 |

环境与登记分别填入 `ITERVANE_OPERATIONS_ENVIRONMENT_ID`、`ITERVANE_OPERATIONS_ENROLLMENT_SHA256`、`ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256`。分别为每个进程注入变量。Restore Worker 的凭证随该进程注入，它从进程环境读取配置。

```sh
pnpm start:api
pnpm start:worker
pnpm start:restore-worker
```

默认的 `ITERVANE_RESTORE_API_ENABLED=0` 保留已有诊断和查询。显式启用时，API 在监听前核对登记和发布目标。每次提交重新核对当前授权、本人确认、提案指纹、目标实例和批准有效期。设回 `0` 后重启 API 即关闭新提交。已经入队或等待核对的处置，继续按各自的批准和执行账本处理。

## 核对运行结果

从实际故障应用生成恢复提案，由同一门户批准人提交。核对回执的原生更新编号、恢复镜像、当前版本及验证时间。授权健康检查应返回 200，匿名访问应由入口拒绝。缺少原生更新的处置进入待人工核对并保留环境占用。有已记录更新的接管只核对原更新。

发布或运维登记轮换后，重新核对进程的配置与实际目标。旧指纹会在启动或提交时被拒。记录中等待核对的处置继续受原操作约束。 [双版本与恢复实证](reviews/p3-c-native-version-restore.md) · [应答中断实证](reviews/p3-c-native-restore-takeover.md)
