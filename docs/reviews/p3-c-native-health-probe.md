# P3-C3-A2 · 受保护应用健康探针导读

本批接续 #121。固定实现 `43bd8f2b1bcbaf89bd430435e504a9fe4c802a5e`，验收代码 `eb695ba2a3f2c9a17bbcb22856137e5b60440b5e`。 [阶段计划](../plans/p3-c-operations-incidents.md) · [安装说明](../control-plane-health.md) · [PR #122](https://github.com/MaLaNg116/itervane/pull/122)

1. Health Worker 通过环境和两个登记指纹锁定一个保护范围。独立 Komodo 读身份在启动时核对身份权限及实际部署，健康凭证由登记的 Keycloak 客户端为本次读请求签发。进程按固定间隔查询，没有操作队列或处置入口。 [进程接线](https://github.com/MaLaNg116/itervane/blob/43bd8f2b1bcbaf89bd430435e504a9fe4c802a5e/packages/control-plane/src/runtime/installed-health-worker.ts#L60) · [启动入口](https://github.com/MaLaNg116/itervane/blob/43bd8f2b1bcbaf89bd430435e504a9fe4c802a5e/packages/control-plane/src/entries/health-worker.ts)
2. 取样先冻结当前实例，执行读取前逐次校验该范围，写入样本时在锁内再核对一次。暂停和目标切换可立即使样本失效。入口和身份服务暂时不可用时保存有限原因及摘要。 [取样与记录](https://github.com/MaLaNg116/itervane/blob/43bd8f2b1bcbaf89bd430435e504a9fe4c802a5e/packages/control-plane/src/runtime/installed-health-worker.ts#L26) · [读取授权](https://github.com/MaLaNg116/itervane/blob/43bd8f2b1bcbaf89bd430435e504a9fe4c802a5e/packages/control-plane/src/service/operations-health.ts#L41)
3. 核验先后读取同一实际容器与 Traefik 入口配置，核对匿名阻断、版本和凭证请求目标。对同一容器明确停止，或同一版本响应合格的 503 JSON，才采为应用异常。原有发布与恢复的验收仍要求健康响应。 [应用健康核验](https://github.com/MaLaNg116/itervane/blob/43bd8f2b1bcbaf89bd430435e504a9fe4c802a5e/packages/control-plane/src/runtime/release-rollout.ts#L104)
4. 托管用例在同一个真实发布上运行六次取样，覆盖健康、容器停止、重启恢复、应用 503、身份服务中断及最终恢复。验证两条事件各自关闭，身份中断只记录未知，样本与事件绑定同一受保护发布和容器。 [原生场景断言](https://github.com/MaLaNg116/itervane/blob/eb695ba2a3f2c9a17bbcb22856137e5b60440b5e/packages/control-plane/test/native/health-proof.ts)

本机 TypeScript、253 项单元、三个 PostgreSQL 17.12 健康账本专项及差异检查通过。单元覆盖代理 503、错误版本、错误容器和已停止容器的独立回读。托管 KVM 原生验收已通过。后续 C3-B 接入健康事件的持久化调度、限次与冷却，C3-C 接入关联修复，C3-D 接入双语门户和 MCP。 [托管检查](https://github.com/MaLaNg116/itervane/pull/122/checks)

固定交付版本 5176b8bd6c5e89c79e71733192140b2126b7d143 的 11 项 KVM 验收通过。原生报告的源码指纹为 da6b0eade6468033b0e034ed0ecb9961df9ff140e85fc3b02fcc37a80a12c00a。同一已发布容器经过六次取样，产生两条异常事件，两条均在实际恢复时关闭。身份服务中断保留当前事件，匿名仍返回 401。同场景的批准已撤销、批准过期、目标变化三种负例各记录零次写入。 [托管任务](https://github.com/MaLaNg116/itervane/actions/runs/45050831325/job/137295351968) · [验收报告](https://github.com/MaLaNg116/itervane/actions/runs/45050831325/artifacts/14766041559)
