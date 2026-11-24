# P4-C3a · 已验证候选的审核与发布

接续 [#143](https://github.com/MaLaNg116/itervane/pull/143)。准入和人工审核固定于 `bdb94293482f1b49c873b6b9c931ed07b1c63889`，验证任务的回查绑定为 `c62d76a363bdf50974b57ee47e692e0fc80de789`。 [实施计划](../plans/p4-validated-package-publication.md)

1. 人类门户所有者选择来源项目、候选和通过的验证摘要。服务读取不可变结果和实际候选，以服务器取得的正文创建草稿。工作区作用域需显式选择。相同内容重试返回原版本；同一生成包的种类与作用域固定。 [草稿与幂等](https://github.com/MaLaNg116/itervane/blob/bdb94293482f1b49c873b6b9c931ed07b1c63889/packages/control-plane/src/service/rule-packages.ts#L99)
2. 数据库核对验证行、提炼成果、作用域、成功状态和正文。审核项区分设计资料和已验证证据，两类审核使用同一不可变版本和审核记录。发布和回滚仍绑定当前授权、审核摘要与激活序号。 [数据库闸门](https://github.com/MaLaNg116/itervane/blob/c62d76a363bdf50974b57ee47e692e0fc80de789/packages/control-plane/migrations/0076_validated_rule_package_publication.sql#L24) · [版本切换](https://github.com/MaLaNg116/itervane/blob/bdb94293482f1b49c873b6b9c931ed07b1c63889/packages/control-plane/src/service/rule-package-activations.ts#L44)
3. 托管场景从受保护应用的健康修复和重启案例进入正式候选验证，随后以签名门户测试身份人工审核并读回激活版本。该场景使用确定性 Anthropic 协议夹具、真实 PostgreSQL、Komodo 和 Whiskers，代码样例使用托管 KVM。 [托管验收脚本](https://github.com/MaLaNg116/itervane/blob/eddd856684fa6f379c540839d45f84ac99b01097/packages/control-plane/test/native/worker-inspection.ts#L1093)

本地 TypeScript、Drizzle、275 项单元与 PostgreSQL 17.12 的 8 项既有 Skill 回归通过。正式候选的数据库回归覆盖重复提交、来源和摘要不符、混用审核项、并发发布、回滚与数据库拒绝换文。双语门户在 C3b 接入，活跃版本在独立后续任务中复用由 P4-D 验收。 [托管检查](https://github.com/MaLaNg116/itervane/pull/144/checks)
