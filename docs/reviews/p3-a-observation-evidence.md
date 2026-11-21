# P3-A2-A · 已发布运维目标导读

接续 [Whiskers 只读观察 #66](https://github.com/MaLaNg116/itervane/pull/66)。固定代码 `3a5fdf014a19a256c6c532ff4da395d8ac3f8ea9`。 [实施计划](../plans/p3-a-observation-evidence.md)

1. 短事务内锁定当前项目授权，再按项目读取受保护环境和正式登记。发起诊断使用现有维护者权限。发布仍在排队、派发或核对时，拒绝选择运维目标。 [项目与环境入口](https://github.com/MaLaNg116/itervane/blob/3a5fdf014a19a256c6c532ff4da395d8ac3f8ea9/packages/control-plane/src/service/operations-deployment.ts#L10)
2. 先按正式成功记录选择最近发布，再解析候选、登记、最终运行回执及已确认的 Komodo 更新。核对同一镜像、容器、映射代次及入口指纹。回执无效时保持错误，登记更换后旧运行证据失去当前目标资格。 [证据绑定](https://github.com/MaLaNg116/itervane/blob/3a5fdf014a19a256c6c532ff4da395d8ac3f8ea9/packages/control-plane/src/service/operations-deployment.ts#L27)
3. 集成测试通过正式发布协调器写入成功证明，覆盖发布占用、跨项目、只读成员、撤权、映射更新和原生标识一致性。 [真实数据库用例](https://github.com/MaLaNg116/itervane/blob/3a5fdf014a19a256c6c532ff4da395d8ac3f8ea9/packages/control-plane/test/integration/inspections.test.ts#L2135)

本机 TypeScript 与 210 项单元检查通过。真实 PostgreSQL 17 验收在托管环境进行。本批先交付可信目标选择，后续以同一绑定登记 Whiskers、入队并保存有执行代次的观察。
