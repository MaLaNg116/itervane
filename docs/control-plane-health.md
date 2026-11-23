# 受保护应用的健康探针

Health Worker 对单个已登记环境周期取样。每次记录绑定当前已核验的发布或恢复回执和具体运行容器。健康结果用于维护事件状态，诊断和处置继续走各自的任务与审批流程。 [阶段计划](plans/p3-c-operations-incidents.md)

## 配置

1. 完成数据库迁移、受保护发布和运维登记。应用健康接口需要对该版本提供 `200 / {"status":"healthy","version":"…"}`，以及应用明确异常时的 `503 / {"status":"unhealthy","version":"…"}`。 [发布安装](reviews/p2-e-release-installation.md) · [受保护入口](../fixtures/ingress/reference/README.md)
2. 为对应 Komodo 部署配置与登记写身份不同的非管理员 `Read`、`Inspect` 身份。准备登记的 Keycloak 健康探针密钥与 HTTPS CA 信任链。 [原生读取权限](reviews/p3-c-restore-komodo-reader.md)
3. 为独立进程注入 `DATABASE_URL`、`ITERVANE_OPERATIONS_ENVIRONMENT_ID`、`ITERVANE_OPERATIONS_ENROLLMENT_SHA256` 和 `ITERVANE_OPERATIONS_RELEASE_TARGET_SHA256`。同时注入下表配置。 [环境变量示例](../.env.example)

| 环境变量 | 用途 |
| --- | --- |
| `ITERVANE_HEALTH_KOMODO_READER_ID` | 对应部署的 Komodo 读身份 ID |
| `ITERVANE_HEALTH_KOMODO_READER_KEY`、`ITERVANE_HEALTH_KOMODO_READER_SECRET` | 上述身份的密钥 |
| `ITERVANE_HEALTH_PROBE_SECRET` | 受保护健康入口登记的 Keycloak 探针凭证 |
| `ITERVANE_HEALTH_POLL_MS` | 两次取样之间的等待时间，默认 30000，范围 5000 至 300000 毫秒 |
| `ITERVANE_HEALTH_INCIDENT_MONITOR_ID` | 可选 UUID。配置后按指定登记尝试派发正式诊断，省略时仅记健康样本与事件 |

以受信进程环境启动。

```sh
pnpm start:health-worker
```

## 启用自动诊断

1. 安装同一环境的正式诊断 Worker，记录其运维登记、发布目标和模型指纹。模型凭证与 Whiskers Read 密钥由该 Worker 保管。 [正式诊断安装](reviews/p3-b-operations-diagnosis-installation.md)
2. 使用有运行配置的受信本机准备 JSON 登记文件。设置 `action` 为 `register`，填写 `environmentId`、`enrollmentSha256`、`mappingSha256`、`providerSha256`、`locale`（`zh-CN` 或 `en`）和 `validUntil`（未来的 UTC ISO 时间）。首份登记的 `expectedActiveId` 为 `null`，轮换时填写上一份登记 ID。
3. 执行下方命令，将返回的 `monitorId` 配置到 `ITERVANE_HEALTH_INCIDENT_MONITOR_ID`，重启 Health Worker。

```sh
pnpm register:operations-incident-monitor ./incident-monitor.json
```

撤销使用同一命令，登记文件填写 `action` 为 `revoke`，以及 `environmentId` 和当前 `expectedActiveId`。撤销、过期或项目授权变化会暂停新的诊断入队，健康样本继续写入。正式 Worker 领取与执行时复核登记和实例。 [诊断准入导读](reviews/p3-c-incident-diagnosis.md)

## 核对采样

已登记容器明确停止或同版本应用返回合格的异常响应时，事件打开或累加。对同一容器和版本观察到健康时关闭该事件。身份服务或入口临时不可用时，取样保留未知状态和原事件。环境有冲突处置、登记已轮换或读取间发布发生变化时，本次结果失去记账资格。

运行记录位于 `itervane.operations_health_samples` 和 `itervane.operations_incidents`。启用自动诊断后，可在 `itervane.operations_incident_diagnoses` 追溯 `incident_id`、触发样本序号及正式任务和运行 ID。调度复用同一活动任务。持续异常的后续尝试需要更新的异常样本，每个环境两次接收至少相隔两分钟，每个事件最多三次。切换登记后，在进程环境更新指纹和对应凭证并重启 Worker。 [探针导读](reviews/p3-c-native-health-probe.md)
