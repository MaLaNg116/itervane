# P2-E-A1 · 已留存 OCI 归档的读取证明

本批基于[复验门户 #38](https://github.com/MaLaNg116/itervane/pull/38)。Runner 从自己的制品目录核对已经留存的归档。正式 Worker 将读取证明与当前代次的复验结论一起提交，供发布候选确认来源。 [P2-E 实施计划](../plans/p2-e-formal-release.md)

1. `8584268` 在已有 Runner socket 增加定长归档描述请求。只有受信任的 Worker UID 可以调用。宿主按固定 SHA-256 查找只读的归档，检查归属、文件类型、链接数、字节数和内容摘要。返回值只有 Runner 镜像摘要和归档描述。 [控制器](https://github.com/MaLaNg116/itervane/blob/8584268/packages/runner/host/qualified_controller.py) · [制品目录](https://github.com/MaLaNg116/itervane/blob/8584268/packages/runner/host/oci_artifacts.py)
2. `dde4f1d` 在正式复验通过且有留存描述后读取证明。发布事务继续检查当前租约及权限，并绑定该证明、Runner 镜像和实际复验回执。读取暂时不可用时，已有复验结论仍可查询。候选冻结以实际读取证明为前提。 [Worker](https://github.com/MaLaNg116/itervane/blob/dde4f1d/packages/control-plane/src/runtime/worker.ts) · [迁移 0028](https://github.com/MaLaNg116/itervane/blob/dde4f1d/packages/control-plane/migrations/0028_formal_oci_archive_verification.sql)
3. `c42ec94` 覆盖真实 PostgreSQL 的证明缺失、长度错配和结果发布回滚。托管 KVM 的正式 Worker 用例将核对第一代 503 和第二代成功归档，并用独立归档读取器比对字节、摘要及镜像清单。 [数据库测试](https://github.com/MaLaNg116/itervane/blob/c42ec94/packages/control-plane/test/integration/inspections.test.ts) · [原生验收](https://github.com/MaLaNg116/itervane/blob/c42ec94/packages/control-plane/test/native/worker-inspection.ts)

67 项 Linux 宿主测试、TypeScript、脚本语法和 138 项真实 PostgreSQL 17 测试通过。首轮全量运行的两个既有测试在取消修复和终止 Worker 后重领时失败。同一 `c42ec94` 固定版本的全量复跑全部通过，首轮异常原因尚未定位。

托管 KVM 的标准 OCI 验收使用 `a3fdbdd375f5cb604a82b51665c084e5b45bf709`，与数据库测试的源码指纹同为 `43def032c730e4a6a3baa8eefa906afb26bf194f60df576fe984480b7f3bda93`。第一代 503 记录了回执，归档读取证明为空。第二代的 `archive_verified` 与独立读取的 79,042,560 字节归档一致，归档 SHA-256 为 `ea9c11067c03d2a50b35d4d478351e3b72e42fc5ba59ed7351e1853dbce4f3af`，镜像清单为 `sha256:b06d063f02fd3674aed1f32d9acdd1567626d92f93652ab704e91b3b7f15d2d7`。第二代结论 SHA-256 为 `be2681ea07992201f9e25e12fea3b43541912789a393a59b860199bf93ba1fcb`，Runner 回执 SHA-256 为 `ef482bea30f6896915700f2ed5222ee86b0bc33b0ff1d98d70c90965143d5ebd`。两代客体和暂存目录均已清理。 [实际归档回读](https://github.com/MaLaNg116/itervane/actions/runs/44911700913/job/136868700544)

P2-E-A2 将读取证明与已登记目标、复验规则和时间窗口绑定，P2-E-C 将核对实际上传到镜像仓库的摘要。
