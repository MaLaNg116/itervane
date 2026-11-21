# P2-E-C4 · 正式 Komodo 目标与派发

基于 Registry 导入及其恢复形成的同摘要制品证据。本批以 Komodo Core/Periphery 2.3.4 为实测参考。 [PR #49](https://github.com/MaLaNg116/itervane/pull/49) · [发布总计划](p2-e-formal-release.md) · [原生 Komodo 验收](../reviews/p0-komodo-native-delivery.md)

## C4-A 目标契约与受限适配

- 在受保护环境的目标版本登记 Komodo 来源和服务账号 ID，现有服务器和 Deployment ID 一并保持绑定。正式接口只接受与 Worker 安装配置相同的来源和身份。已有登记保留原指纹，补登会产生新目标版本。
- 冻结实际 Deployment 的完整运行配置摘要，计算时排除本次需要变更的镜像字段，并对对象键顺序归一化。服务器、网络、环境、重启策略等仍参与摘要；响应里的环境值与凭证都不写入事件或证据。支持由受控网络承载的单实例 Deployment，拒绝宿主网络、容器网络共享、宿主挂载、自定义命令和额外 Docker 参数。 [固定版本配置](https://github.com/moghtech/komodo/blob/v2.3.4/client/core/rs/src/entities/deployment.rs)
- 适配器只暴露目标读取、配置固定镜像、派发和更新核对。镜像来自已验证 Registry 所绑定的仓库和 manifest digest。配置更新只写镜像字段，写前核对当前配置和原镜像，写后独立回读。派发前核对原生目标和已配置同一摘要，结果查询核对更新 ID、服务账号、动作和 Deployment。将 HTTP 异常、超时和不明回执交给领域层判定，不自行重放写入。 [Komodo API](https://komo.do/docs/ecosystem/api) · [固定版本更新请求](https://github.com/moghtech/komodo/blob/v2.3.4/client/core/rs/src/api/write/deployment.rs)
- 保持 P0 独立证据，复用临时真实 Core、Periphery、Registry 与最小权限凭证验证正式适配器。覆盖错配目标、配置漂移、原镜像漂移、异源凭证和更新记录绑定，并核对实际运行的固定样例。

## C4-B 领域派发与恢复

- 接续同一操作和有效 fence 下的新 Registry 证明。配置写入和部署派发各有唯一持久化意图，包含固定版本目标、原镜像、批准摘要和发送 fence。每个有副作用的调用前重新核对授权、审批有效期和当前环境。
- 配置更新结果不明时先读实际配置和镜像绑定。派发获得原生更新 ID 后记录，并以只读方式独立核对。无法确定派发结果时保留环境占用，使用足够的下游证据或人工核对，禁止重复发送 Deploy。
- 在真实受保护环境上验证失去回执及 Worker 中断恢复。E-D 再独立核对实际运行镜像、配置、访问保护与健康。完整 P2 通过后才开启生产发布入口。
