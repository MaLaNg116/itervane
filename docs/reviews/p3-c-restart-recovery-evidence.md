# P3-C2c3a · 重启恢复证据导读

本批接续 #96 的写入意图和原生回执。代码快照为 `803ebffb960302cd1cde208e775c1f7f3a3f0bf1`。 [PR #97](https://github.com/MaLaNg116/itervane/pull/97) · [恢复核验与结算计划](../plans/p3-c-restart-recovery-evidence.md)

## 阅读顺序

1. `d86b601` 复用 Komodo 的已登记部署和镜像观察，读取停止态的同一容器与精确启动时间。只保留结构化身份、镜像、配置和网络事实。启动时间规范为 UTC，保留 Docker 提供的九位小数精度。缺少有效启动时间时无法建立停止锚点。 [证据契约](https://github.com/MaLaNg116/itervane/blob/803ebffb960302cd1cde208e775c1f7f3a3f0bf1/packages/contracts/src/operations.ts) · [Komodo 读侧](https://github.com/MaLaNg116/itervane/blob/803ebffb960302cd1cde208e775c1f7f3a3f0bf1/packages/control-plane/src/runtime/release-komodo.ts)
2. 同一提交将恢复观察接入发布核验器。只有同一实例启动时间推进，才检查 Traefik 路由与访问保护。验证授权健康之前和之后分别读取容器，要求实例、启动时间、镜像与网络一致，健康接口还需返回原发布版本。 [恢复核验](https://github.com/MaLaNg116/itervane/blob/803ebffb960302cd1cde208e775c1f7f3a3f0bf1/packages/control-plane/src/runtime/release-rollout.ts)
3. `803ebff` 增加停止态、镜像及实例替换、同一毫秒内的启动推进、复查中重启和健康版本漂移用例。原生场景只能停止、恢复带有本轮可信标签和确切容器 ID 的夹具，读取使用正式适配器。 [单元测试](https://github.com/MaLaNg116/itervane/blob/803ebffb960302cd1cde208e775c1f7f3a3f0bf1/packages/control-plane/test/unit/release-rollout.test.ts) · [原生 Komodo](https://github.com/MaLaNg116/itervane/blob/803ebffb960302cd1cde208e775c1f7f3a3f0bf1/packages/verification/src/native/komodo-probe.ts) · [KVM 标准应用](https://github.com/MaLaNg116/itervane/blob/803ebffb960302cd1cde208e775c1f7f3a3f0bf1/packages/control-plane/test/native/worker-inspection.ts)

## 验收与接续

TypeScript 和 244 项单元通过。原生 Komodo 八项检查通过，含 `restart-runtime-readback`，源码指纹 `9571cb0bb6b217f7b02a02587ca8ae2bcd18df8fb858d92588d5604274911de2`。KVM 场景对已发布的同一标准应用增加真实访问保护和恢复版本核对，按固定代码快照的托管结果归档。 [Komodo 报告](https://github.com/MaLaNg116/itervane/actions/runs/45003300502) · [KVM 检查](https://github.com/MaLaNg116/itervane/actions/runs/45003300535)

初轮 KVM 在恢复核验之前的日志调查停止。`829f944` 同步 #96 对主线只读工具名单的恢复，继续验证同一标准应用，包括 Traefik、Keycloak 与新启动的容器。 [首轮失败作业](https://github.com/MaLaNg116/itervane/actions/runs/45003300535/job/137149313859) · [复验检查](https://github.com/MaLaNg116/itervane/pull/97/checks)

前置 #96 的 19 项原生检验也已通过，其中 `sealed-writer` 验证了正式装载器读取实际挂载的 Confirm 策略和角色文件。C2c3b 将停止锚点同发送意图持久化并提交恢复结算。C2c3c 在同一标准应用接通真实 Whiskers 人审、写派发、查询和恢复验证。 [Whiskers 报告](https://github.com/MaLaNg116/itervane/actions/runs/45002323151)

合入前复核了同一容器的停止和启动证据、纳秒精度、镜像与网络绑定，以及访问保护和健康核验前后的实例一致性。固定复核版本 `be55e5e22472c3bd0887449d1bc3ecf24d2c7048` 通过全部 17 项检查，已合入 `60cd1aff0756032c838afa230c7d20dc99550e3a`。 [常规 PR](https://github.com/MaLaNg116/itervane/actions/runs/45033679152) · [推送检查](https://github.com/MaLaNg116/itervane/actions/runs/45033674806) · [九项托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45033674814) · [原生 Komodo](https://github.com/MaLaNg116/itervane/actions/runs/45035506932) · [OCI 输入](https://github.com/MaLaNg116/itervane/actions/runs/45033674824)
