# P4-D2b4a · 独立 Runner 复验已发布规则

本批增加独立规则重扫通道。围绕已归档的审计扫描回执与发布目标验证。 [本批计划](../plans/p4-qualified-published-verification.md) · [#150](https://github.com/MaLaNg116/itervane/pull/150)

1. `421e836` 冻结审计规则回执摘要、任务规则快照和复验规则集，分别为原稿、修复候选校验文件清单。客户端核对选择的交付目标哈希、规则集和实际覆盖。 [复验命令](https://github.com/MaLaNg116/itervane/blob/421e836/packages/runner/src/verification-command.ts) · [来宾证据](https://github.com/MaLaNg116/itervane/blob/421e836/packages/runner/src/guest-inspection.ts)
2. `d570a1c` 控制器在现有租约、镜像和工具资格下核对有界的规则命令，在 VM 中对实际目标重扫。带规则的回执可附有界目标清单，其他复验保持原来的传输上限。 [原生准入](https://github.com/MaLaNg116/itervane/blob/d570a1c/packages/runner/host/qualified_controller.py)
3. `57ace6f` 复验正例覆盖原稿和修复候选，验证文件更换和缺失证据被拒绝。托管用例要求独立虚拟机重扫同一固定样例，核对命中、来源、镜像和清理。 [回归用例](https://github.com/MaLaNg116/itervane/blob/57ace6f/packages/runner/test/unit/published-verification-command.test.ts) · [托管验收](https://github.com/MaLaNg116/itervane/blob/57ace6f/packages/control-plane/test/native/rule-samples.ts)

TypeScript、284 项单测、81 项 Linux 主机测试和托管探针打包通过。新增托管用例的真实回执由对应 KVM 工作流产出。正式复验的结果比较、持久化与发布裁决由下一批实现。
