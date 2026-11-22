# P3-C2c2b1 · Whiskers 单工具写凭证与原生审批导读

本批接续 #93 的续发和发送意图，固定代码版本为 `e45a3d3602e7011611e1301d89d273e091bd02aa`。 [草稿 #94](https://github.com/MaLaNg116/itervane/pull/94) · [阶段计划](../plans/p3-c-whiskers-restart-execution.md)

1. `9244205` 在同一 MCP 连接上核对固定 Whiskers 版本和当前写凭证的原生权限资源。作用范围须显式限定为 `restart_container`。权限缺失、范围扩大或响应无法识别时，发送授权回调和容器工具都不执行。 [适配器检查](https://github.com/MaLaNg116/itervane/blob/e45a3d3602e7011611e1301d89d273e091bd02aa/packages/control-plane/src/runtime/whiskers-mcp.ts#L73) · [上游权限资源](https://github.com/LupusMalusDeviant/Whiskers/blob/e10cfa62ed8c3129302f68e0b4ec6e3ece8994e4/src/Whiskers/Mcp/Resources/WhiskersResources.cs)
2. `aec0144` 为固定镜像的临时安装准备只读角色映射和 Confirm 策略。Operator 使用独立的网页身份，原生批准界面可用，护栏编辑要求管理员。夹具保留两把单工具写凭证、只读观察凭证和专门用于阻断用例的广范围凭证。配置只保存指纹，报告保存结果和关联标识。 [夹具安装](https://github.com/MaLaNg116/itervane/blob/e45a3d3602e7011611e1301d89d273e091bd02aa/packages/portal/test/native/whiskers-fixture.ts#L107) · [原生测试](https://github.com/MaLaNg116/itervane/blob/e45a3d3602e7011611e1301d89d273e091bd02aa/packages/portal/test/native/whiskers.ts#L85)
3. 首轮实测在原生权限格式校验处阻断。`e45a3d3` 按有效行校验权限资源，并仅记录资源结构。复验确认同一凭证仅有重启权限，广范围凭证被拒绝。原始调用停在待批，同身份、同参数的续发在 Operator 确认后仅重启一次，其他容器保持原状态。再次调用需要新的批准。核对原生审计与卸载清理。 [首次实测](https://github.com/MaLaNg116/itervane/actions/runs/44997893415) · [17 项原生复验](https://github.com/MaLaNg116/itervane/actions/runs/44998153417/job/137133578762)

本机通过 TypeScript、232 项单元和差异检查。已验证的范围是 Whiskers 参考安装及适配器的单工具授权、真实审批和重启。C2c2b 后续交付将安装代次绑定到已发布目标和执行租约，并处理旧许可隔离。C2c3 完成独立健康核验及正式执行启用条件。 [托管检查](https://github.com/MaLaNg116/itervane/pull/94/checks)

2026-11-22 合入复核固定在 `020c7b10df01cfcef5abb09281fe57586af91515`。核对 MCP 同连接的写凭证权限、真实 Operator 审批和广范围凭证阻断。17 项托管检查全部通过，含九组 KVM、原生 Whiskers、密封输入和常规回归。 [原生验收](https://github.com/MaLaNg116/itervane/actions/runs/45022896657) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/45022896722) · [主线合并提交](https://github.com/MaLaNg116/itervane/commit/4fd1908c87e82594be02495ab415f8d22669eefd)
