# P3-C3-C3a · 用第二次健康请求复现应用故障

接续 #126 的确认和固定源码。探针与 Runner 回执固定为 `44175534547e0f39b93fc202346b558856e93e0f`，任务与结算固定为 `66137d535649352fa6b34ef28eaa057ce839a829`，验收代码固定为 `f53d14dbfe4a475397ca8f07c939d40dc6904f05`。 [实施计划](../plans/p3-c-linked-repair-reproduction.md) · [PR #127](https://github.com/MaLaNg116/itervane/pull/127)

1. 从已确认的关联任务读取健康事件及样本。样本须指向同一环境、同一发布证明，且属于同版本应用异常。把提案、诊断、发布与样本摘要冻结到原版复验输入。授权续租、实测回执结算和对任务发布结论时，都重新核对该关联。 [冻结健康样本](https://github.com/MaLaNg116/itervane/blob/66137d535649352fa6b34ef28eaa057ce839a829/packages/control-plane/src/runtime/verification-input.ts#L20) · [结算闸门](https://github.com/MaLaNg116/itervane/blob/66137d535649352fa6b34ef28eaa057ce839a829/packages/control-plane/src/service/verification-result.ts#L65)
2. 封存探针在首次健康检查通过后，通过同一虚机内应用入口访问第二次 `/health`。常规五项基线照常留存，单列续测状态。将同版本且具有预期响应结构的 HTTP 503 记作已复现应用异常，分别记录健康响应、版本或响应不符、连接异常。命令和回执共同绑定续测类型。 [封存探针](https://github.com/MaLaNg116/itervane/blob/44175534547e0f39b93fc202346b558856e93e0f/fixtures/runner/standard-web-baseline.mjs#L23) · [Runner 回执核对](https://github.com/MaLaNg116/itervane/blob/44175534547e0f39b93fc202346b558856e93e0f/packages/runner/src/qualified-client.ts#L135)
3. 原版复现证据进入正式复验结果和中英文任务事件。任务依实测结果进入人工处理，原版重放走无 OCI 输出的验证配置。后续批次让有可信复现的任务进入受限修复，在另一台一次性 VM 上通过同一用例后才具备候选资格。 [任务用例](https://github.com/MaLaNg116/itervane/blob/f53d14dbfe4a475397ca8f07c939d40dc6904f05/packages/control-plane/test/integration/inspections.test.ts#L3379)

本地 TypeScript、253 项单元、72 项 Linux Runner 宿主测试、3 项真实回环 HTTP 测试、两条工作流语法检查通过。PostgreSQL 17.12 的 23 项相关用例通过，加入结果发布时的关联复核后复跑 6 项专项，覆盖已复现、健康、响应无法核实、缺失回执及授权撤销。真库用例使用签名 OIDC、确定性模型、Whiskers 与 Runner 回执夹具。

托管 `standard-build` 场景分别启动正常和带连续健康缺陷的固定源码，检查首次 200、续测结果、独立 VM 回执与清理。该场景使用真实 KVM 和本机应用，通过测试账本提供诊断来源。托管结果随 PR 更新，已部署受保护应用、Whiskers、Komodo 和真实 Agent 的联验由 C3-C3c 接续。 [托管断言](https://github.com/MaLaNg116/itervane/blob/f53d14dbfe4a475397ca8f07c939d40dc6904f05/.github/workflows/native-runner.yml#L185) · [固定缺陷源码](https://github.com/MaLaNg116/itervane/commit/bd2d14e3485d30429740d4403ac0bd36fc40420d)
