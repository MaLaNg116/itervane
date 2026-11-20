# 010 · P2-B 候选冻结与人工确认导读

- 基线为合并后的 `main`，版本 `8f1ad45769dce23ef049751e546be11a9638da10`。
- 固定代码版本为 `971653fb1170f6230e3b088bd7a5362426d3d60a`。先读 [实施计划](../plans/p2-b-release-candidate.md) 和 [v6 的授权绑定](../blueprint-v6.md#14-授权绑定具体交付物与操作)。

## 1. 候选绑定哪些事实

先看 manifest。指纹覆盖任务和 run 代次、原始 commit、源码与修复快照、差异、模板/规则/验证工具链、三类复验及镜像检查引用、镜像 digest、运行配置、目标映射、上线验证、恢复计划和有效期。镜像使用 digest 引用，数据库存材料摘要与证据引用。校验后的 manifest 按契约字段顺序序列化并计算 SHA-256。 [候选契约](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/contracts/src/release.ts#L9)、[指纹计算](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/src/service/releases.ts#L23)

`freeze` 在短事务锁定任务，读取可信证据端口的当前版本，对照任务、run、代次、原 commit 与同项目环境。同版同指纹重试取回原记录和有效期。版本倒退或同版内容冲突会拒绝。候选与决定分表保存；关联约束校验任务、run、目标的范围，运行账号直接更新或删除历史行会被数据库触发器拒绝。 [冻结](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/src/service/releases.ts#L93)、[追加式约束](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/migrations/0007_release_candidates.sql#L37)

## 2. 谁确认，确认对什么生效

读取使用现有项目权限。决定要求经过身份验证的工作区所有者和服务端配置的人用 OIDC 客户端。命令只接受明确动作、候选指纹、预期决定版本和幂等键。服务端读取操作者和授权实例，同一人提交并确认时标明本人确认。越权查询沿用资源不可见语义。 [决定契约](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/contracts/src/release.ts#L44)、[授权检查与事务](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/src/service/releases.ts#L134)、[身份隔离测试](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/test/integration/releases.test.ts#L145)

决定追加审计历史。两项并发决定在同一个任务行锁上排队，提交后的版本决定重试与冲突结果。撤销追加第二条记录，重放旧请求时返回当前结果。候选被替代、证据漂移、任务状态改变或授权实例撤销后，旧决定失效。授权实例随重新授予生成新 UUID，即使仍是同一人也不会复活旧决定。有效期从取得行锁、读完权威数据后采样的 PostgreSQL 时钟判定。 [有效性计算](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/src/service/releases.ts#L177)、[并发测试](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/test/integration/releases.test.ts#L168)、[撤权和过期测试](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/test/integration/releases.test.ts#L212)

## 3. 如何核对

| 验证 | 结果 |
| --- | --- |
| `pnpm check` | TypeScript 严格检查和 92 项单元通过 |
| `pnpm test:integration` | 78 项真实 PostgreSQL 17 测试。新增 9 项覆盖冻结重放、双语本人确认、项目/客户端隔离、并发、变更过期、撤权复授、历史不可变及提交失败回滚 |
| `pnpm test:portal` | 21 项浏览器用例通过，原 OIDC、任务、规则和预审入口回归 |
| 存量迁移 | 在一次性 PostgreSQL 中先应用至 `0006`，写入旧所有者和项目，升级 `0007` 后查询到原记录和新增授权标识 |

先跟一次从冻结到确认、重连读取的测试，再检查持有行锁直至证据过期的用例，以及事务提交时才抛错的用例。PG 测试使用正常领域迁移、受限运行角色、签名身份和随事务读取的测试证据表。 [主路径](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/test/integration/releases.test.ts#L103)、[锁竞争和时间](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/test/integration/releases.test.ts#L226)、[提交回滚](https://github.com/MaLaNg116/itervane/blob/971653fb1170f6230e3b088bd7a5362426d3d60a/packages/control-plane/test/integration/releases.test.ts#L268)

## 4. 正式接入的验收条件

本段只处理维护者合成任务和可信样例证明，`releaseEligible` 始终为 `false`。测试中的镜像、扫描和配置使用固定摘要，当前确认不会唤醒业务队列。正式 API、MCP 和 Worker 仍由 P1-E Runner 闸门控制。

正式审批须读取经租约和领域发布指针绑定的合格 VM 复验及实际镜像扫描，取得经过核验的真实目标，使用可锁定且版本单调递增的权威资料。确认、唯一操作记录和队列唤醒同一事务提交，执行时再检查租约、授权、有效期和目标，随后核对 Komodo 实际运行版本及健康。 [运行资格](../decisions/0001-development-and-runtime-gates.md)、[领域检查点](../decisions/0002-checkpoint-publication.md)
