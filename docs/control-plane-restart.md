# 自托管运维重启

重启使用已核验的受保护发布、正式诊断和人工批准。平台审批人与 Whiskers Operator 分别在各自的界面批准。任务通过原生后端执行，恢复由独立读身份核对。 [阶段计划](plans/p3-c-native-restart-loop.md)

## 准备环境和登记

1. 完成数据库迁移、门户登录、隔离 Runner 和受保护应用发布。保留发布目标登记的版本与摘要，以及环境的正式诊断模型指纹。 [门户](control-plane-p1-c.md) · [受保护入口](../fixtures/ingress/reference/README.md) · [发布安装](reviews/p2-e-release-installation.md) · [正式诊断](reviews/p3-b-operations-diagnosis-installation.md)
2. 使用参考 Whiskers 镜像版本和 Confirm 策略。为诊断进程设只读凭证，为重启进程设只允许 `restart_container` 的 Write 凭证。为原生审批设独立的 Operator 登录。角色文件中离线管理员只用于配置，登录身份使用 Operator。 [参考策略](../fixtures/whiskers/guardrails.json) · [角色与密钥示例](../packages/portal/test/native/whiskers-fixture.ts)
3. 以单独的 Komodo 非管理员身份读取该部署，赋予该部署的 `Read` 与 `Inspect`。准备发布映射中 Keycloak 健康探针身份的密钥。 [读身份范围](reviews/p3-c-installed-restart-worker.md)
4. 准备 `installation.json`，使用下表字段。另存登记请求，将 `action` 设为 `register`，首次的 `expectedActiveId` 设为 `null`，`installation` 放入完整文档。 [登记契约](../packages/control-plane/src/service/operations-restart-installations.ts)

| 安装字段 | 值 |
| --- | --- |
| `version`、`installationId` | 版本 1 与本代新 UUID |
| `environmentId`、`enrollmentSha256` | 当前受保护环境及 Whiskers 只读登记回执 |
| `whiskers` | 当前登记的 `origin` 与 `serverId` |
| `imageDigest` | 固定 Whiskers 镜像摘要，见运行契约 |
| `policySha256`、`rolesSha256` | 实际安装的策略和角色文件的字节 SHA-256 |
| `credentialSha256` | 单工具 Write 密钥字符串的 UTF-8 SHA-256 |

把登记请求文件交给受信安装进程。命令输出安装代次与摘要，用于核对安装文件。 [运行契约](../packages/contracts/src/operations.ts)

```sh
pnpm register:operations-restart-installation /run/itervane/restart/register.json
```

## 启动进程

API 与 Worker 使用同一环境登记和正式诊断范围。各进程从独立的环境配置或受管 secret 读取自己的凭证。 [配置示例](../.env.example)

| 进程 | 配置 |
| --- | --- |
| API | 启用 `ITERVANE_OPERATIONS_API_ENABLED=1`，设置正式诊断模型指纹、现有门户客户端和 `ITERVANE_RESTART_API_INSTALLATION_FILE`。安装文件只包含登记材料与指纹。 |
| 诊断 Worker | 配置正式诊断模型与该环境的 Whiskers Read 密钥。 |
| 重启 Worker | 配置发布目标摘要和已登记的安装、策略、角色文件，注入 Whiskers Write、独立 Komodo 读身份及健康探针的凭证。 |

说明中的绝对路径由安装方按实际环境提供。API 和重启 Worker 可分别由进程管理器启动。

```sh
pnpm start:api
pnpm start:worker
pnpm start:restart-worker
```

每次启动时，API 核对活跃登记、受保护环境和发布映射。默认模式提供已启用的诊断与回执查询。设置重启安装路径后，实际排队和续发仍逐次核对当前门户授权、原决定及安装代次。

## 验收与轮换

在标准应用上验证诊断、平台批准、Whiskers 批准、续发和独立恢复。回执关联实际发布、原生批准编号和恢复摘要。授权健康检查应返回 200，匿名请求应由入口拒绝。环境仍显示由待核对处置占用时，冲突发布会被阻断。

轮换时生成新的安装 UUID 和新密钥指纹，登记请求的 `expectedActiveId` 填原登记的 ID。登记成功后更新两类进程各自的安装文件和凭证并完成重启。原代次的待核对记录和环境占用继续受原处置账本约束。 [轮换与历史回执](reviews/p3-c-whiskers-restart-installation.md)
