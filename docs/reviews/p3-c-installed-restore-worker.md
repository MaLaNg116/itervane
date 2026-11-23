# P3-C2d4a · 自托管恢复 Worker 导读

本批依赖 #112。固定实现为 `539d1985eb38738ea9751109952e61d2b34e3e08`，原生验收脚本及完整代码为 `d071529d4aaf93713fcd75c071573e914437b5dc`。 [实施计划](../plans/p3-c-operations-restore.md) · [PR #113](https://github.com/MaLaNg116/itervane/pull/113)

1. PostgreSQL 迁移创建 `operations-restore-v1`。冻结提案中的动作决定首次派发、重试、撤销和接管进入哪个队列。两类 Worker 使用同一个租约分配方法，处置仍受全局执行槽、环境占用、原审批和当前目标保护。 [首次和续发入队](https://github.com/MaLaNg116/itervane/blob/d071529d4aaf93713fcd75c071573e914437b5dc/packages/control-plane/src/runtime/operations-execution-queue.ts#L17) · [领取和租约](https://github.com/MaLaNg116/itervane/blob/d071529d4aaf93713fcd75c071573e914437b5dc/packages/control-plane/src/runtime/operations-execution-lease.ts#L165)
2. 核对丢失的任务时，以处置日程中保存的唤醒 ID 为准。确认日程仍匹配后，在事务中撤销旧唤醒并发布替代任务。旧队列中遗留的恢复唤醒由此迁移。发送后重新领取只会走已保存意图的独立核验。 [队列核对](https://github.com/MaLaNg116/itervane/blob/d071529d4aaf93713fcd75c071573e914437b5dc/packages/control-plane/src/runtime/operations-execution-lease.ts#L588) · [迁移与接管用例](https://github.com/MaLaNg116/itervane/blob/d071529d4aaf93713fcd75c071573e914437b5dc/packages/control-plane/test/integration/inspections.test.ts#L2986)
3. `pnpm start:restore-worker` 绑定当前受保护环境、诊断登记和发布映射。启动校验原 Komodo 写身份以及独立非管理员读身份。恢复发送使用写适配器，停止状态、原生更新、受保护入口和健康由读适配器及探针核对。 [配置契约](https://github.com/MaLaNg116/itervane/blob/d071529d4aaf93713fcd75c071573e914437b5dc/packages/control-plane/src/config.ts#L145) · [装机与适配器接线](https://github.com/MaLaNg116/itervane/blob/d071529d4aaf93713fcd75c071573e914437b5dc/packages/control-plane/src/runtime/installed-restore-worker.ts#L28)
4. 真库覆盖旧队列唤醒、丢失、审批撤销和过期。首轮捕获联表锁定的表名限定问题，已改用明确的关系别名并复跑。原生验收脚本额外核对同身份凭证拒绝、失配目标拒绝，以及已登记 Worker 的空闲轮询。 [发布及撤销测试](https://github.com/MaLaNg116/itervane/blob/d071529d4aaf93713fcd75c071573e914437b5dc/packages/control-plane/test/integration/inspections.test.ts#L3018) · [原生安装场景](https://github.com/MaLaNg116/itervane/blob/d071529d4aaf93713fcd75c071573e914437b5dc/packages/control-plane/test/native/worker-inspection.ts#L1158)

运行前按安装角色执行 `pnpm db:migrate`，在恢复进程注入登记的环境与发布指纹、Komodo 双身份和健康探针凭证。部署配置说明与变量见示例。 [环境变量](../../.env.example)

TypeScript、248 项单元和 20 项 PostgreSQL 17.12 专项通过。双语事件继续使用现有消息契约。门户人工提交、MCP 回执与同一应用双版本实际恢复由 C2d4b 和 C2d4c 验收，恢复提交入口在双版本联验通过后启用。 [托管检查](https://github.com/MaLaNg116/itervane/pull/113/checks)

固定代码的原生装机首轮在离线扫描器输入校验中止。用原提交复跑受影响作业后，九项 KVM 检查全部通过。原生装机场景验证了登记目标失配被拒、读写身份分开以及队列无任务时保持空闲。 [首轮准备失败](https://github.com/MaLaNg116/itervane/actions/runs/45032419249/job/137238693334) · [原生装机与九项 KVM](https://github.com/MaLaNg116/itervane/actions/runs/45032419249/attempts/2)
