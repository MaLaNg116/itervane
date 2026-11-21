# P2-E-D · 独立上线核验与正式发布出口

从 [Komodo Worker #52](https://github.com/MaLaNg116/itervane/pull/52) 的待运行核验状态接续。同一操作已经取得原生更新终态且保留环境占用。真实运行证据齐全后才能完成发布。本批沿用 v6 的 Komodo、OIDC 及受保护入口边界。 [发布总计划](p2-e-formal-release.md) · [v6 蓝图](../blueprint-v6.md)

## D1 · 固定运行版本

用绑定的 Komodo 目标回读配置，并调用 `InspectDeploymentContainer` 取得实际容器 ID、状态、请求镜像引用和镜像配置摘要。当前运行配置摘要、参考网络、无宿主端口绑定和非特权运行都要核对。完整环境变量、挂载详情和请求认证不写入证明。 [Komodo v2.3.4 部署读取契约](https://github.com/moghtech/komodo/blob/v2.3.4/client/core/rs/src/api/read/deployment.rs) · [固定版本容器结构](https://github.com/moghtech/komodo/blob/v2.3.4/client/core/rs/src/entities/docker/container.rs)

维护者在 Komodo 为核验服务身份配置登记 Deployment 的 `Inspect` 专项权限。该权限只授予已登记 Deployment；适配器按已冻结的目标身份发起读取。 [部署读取权限实现](https://github.com/moghtech/komodo/blob/v2.3.4/bin/core/src/api/read/deployment.rs#L293) · [Inspect 权限定义](https://github.com/moghtech/komodo/blob/v2.3.4/client/core/rs/src/entities/permission.rs#L167)

## D2 · 入口和健康

安装维护者登记核验配置。它包含规范 HTTPS 入口、固定健康路径、应用授权的探测身份引用及受控运行网络，并用现有 `rolloutCheckSha256` 绑定冻结候选。探测凭证只由安装侧提供。入口控制继续沿用实施计划的 OIDC 和 Traefik，实际路由必须落到本次登记的后端。

对同一路径分别验证匿名请求拒绝及获授权请求成功，标准应用使用固定 `/health` 响应规范。使用显式的重定向策略和小型响应上限，不向意外地址转发凭证。入口核对前后回读容器 ID 和版本，期间漂移会使结果进入待核对。真实夹具应分别覆盖直连端口、错误后端、匿名放行、错误镜像和健康失败。

## D3 · 状态、证据和故障验收

- 对同一已记录的 Komodo 更新取得独立只读核验资格。核验使用单独并发额度，不占用 Agent 模型循环的全局执行槽。目标环境保持占用直到核验证据完成结算。
- 证据绑定操作、候选、版本化目标、原生更新 ID、实际容器版本、审核配置及完成时间。真实终态、运行版本和入口结果分别保留。超时、冲突或安全检查失败时停止继续写入，明确区分失败、结果未知和请求取消。
- 用两种语言呈现运行阶段与最终结果。验证真实 PostgreSQL 的重试、失去执行权、重复读包、无证据无法结算和同环境操作互斥。真实托管试验从获批 OCI 开始，最终比对运行镜像、身份入口的双向结果与健康。
- 自托管生产入口在安装配置、受保护入口、跨进程恢复和全部 P2 正反回归都通过后再放行。P3 的诊断、重启、指定版本恢复和规则沉淀继续按原蓝图推进。
