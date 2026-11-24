# P4-A1 · 设计 Skill 草稿库

接续 [PR #134](https://github.com/MaLaNg116/itervane/pull/134) 的迁移基线。契约固定于 `7566a5ab0e7dbec9c879ae78aff4778ea35c1c2d`，迁移为 `030cda00420f3e8260670cb5b6af202778ba0e82`，接口为 `9995fb60dc68b8975bdf21a8ebfc22e39d839dcc`。 [P4 计划](../plans/p4-rule-learning.md)

1. 导入参数包含双语元数据、来源、许可证、工作区或项目作用域、`SKILL.md`、参考 Markdown 与设计 JSON。拒绝未知字段、重复路径和超限包。附件排序、换行规范化后产生版本摘要。 [导入契约](https://github.com/MaLaNg116/itervane/blob/7566a5ab0e7dbec9c879ae78aff4778ea35c1c2d/packages/contracts/src/rule-packages.ts#L38)
2. 所有者导入时核对当前项目与授权代次，事务内锁定归属包。同一版本与摘要重放返回原记录，内容变更返回 409。数据库复合外键约束项目和包归属，触发器保存历史版本及导入授权。 [导入事务](https://github.com/MaLaNg116/itervane/blob/9995fb60dc68b8975bdf21a8ebfc22e39d839dcc/packages/control-plane/src/service/rule-packages.ts#L36) · [迁移约束](https://github.com/MaLaNg116/itervane/blob/030cda00420f3e8260670cb5b6af202778ba0e82/packages/control-plane/migrations/0071_rule_package_drafts.sql#L40)
3. `GET /v1/rule-packages` 按当前工作区提供分页摘要，`GET /v1/rule-packages/:packageId/versions/:versionId` 读取指定草稿。读取时重算摘要。内容以定界数据形式保存，进入验证、人工审核和运行时目录需后续发布批次。 [授权读取](https://github.com/MaLaNg116/itervane/blob/9995fb60dc68b8975bdf21a8ebfc22e39d839dcc/packages/control-plane/src/service/rule-packages.ts#L62)

本地 TypeScript、Drizzle 检查和 253 项单元通过。PostgreSQL 17.12 的 4 项新用例和 6 项预审回归通过，覆盖清库迁移、并发、作用域、身份撤销、历史只读及入库回滚。首轮真库发现生成器把项目复合唯一键排在引用外键之后，调整顺序后从空库复跑通过。用例采用签名 OIDC 测试身份和合成设计材料。 [真库用例](https://github.com/MaLaNg116/itervane/blob/91d8454e674eed00facf274938e04aeae6fd1b8f/packages/control-plane/test/integration/rule-packages.test.ts#L59) · [托管检查](https://github.com/MaLaNg116/itervane/pull/135/checks)
