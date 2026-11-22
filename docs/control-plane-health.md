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

以受信进程环境启动。

```sh
pnpm start:health-worker
```

## 核对采样

已登记容器明确停止或同版本应用返回合格的异常响应时，事件打开或累加。对同一容器和版本观察到健康时关闭该事件。身份服务或入口临时不可用时，取样保留未知状态和原事件。环境有冲突处置、登记已轮换或读取间发布发生变化时，本次结果失去记账资格。

运行记录位于 `itervane.operations_health_samples` 和 `itervane.operations_incidents`。核对环境、发布操作、恢复记录及证据摘要。切换登记后，在进程环境更新指纹和对应凭证并重启 Worker。 [验收与代码导读](reviews/p3-c-native-health-probe.md)
