# P2-D3-C3-C · OCI 产物保留 Review Guide

本批依赖 [客体镜像和扫描 #31](https://github.com/MaLaNg116/itervane/pull/31)，运行代码首版为 `5e7147afd2cd14f57132a99d9747c3968bca11e8`。 [本批计划](../plans/p2-d3-c3-oci-artifacts.md)

1. `52f2b2b` 将留存意图、格式、SHA-256 和字节数绑定到实际复验回执。当前租约由已有正式事务校验，数据库拒绝缺失已申请的制品证据。 [制品契约](../../packages/contracts/src/qualified-standard-image.ts) · [事务迁移](../../packages/control-plane/migrations/0024_formal_oci_artifact_receipt.sql)
2. `8eaf665` 在客体内归档已经 Trivy 核验的 OCI 布局。宿主控制器仅在申请的会话接收有界字节分块，流式核验 SHA-256 与长度。临时文件等 VM 清理后才按内容地址原子保留，校验既有地址并去重。 [镜像归档](../../packages/runner/host/oci_guest.py) · [宿主存储](../../packages/runner/host/oci_artifacts.py)
3. `5e7147a` 用独立读取程序复算实际存储归档的 manifest。GitHub 只保留摘要和回执，平台运行程序在接收归档时保持字节流处理。 [独立核验](../../fixtures/runner/verify-stored-oci.py)

TypeScript、65 项宿主测试和 PostgreSQL 全量 121 项已通过。宿主对照覆盖截断、改写、取消中的流、相同制品竞争和既有地址损坏。本机可信 OCI 试验通过归档写入和独立 manifest 读取，正式标准候选的 [托管 KVM](https://github.com/MaLaNg116/itervane/actions/runs/44898778492) 使用 `1a762b1c1916b6e03a699e28f45786ab8f2dabc1`。后续 P2-E 用同一内容摘要准备真实人审发布。

首轮原生运行已传回并留存 79,042,560 字节，宿主独立校验长度、权限和 SHA-256 `b1b991b6c851a3cf0052b3fa2a29ed9b5f66bb49c782ca52abd0291d433703e3`。正式复验回执为 `21c27b7fd02ae2590c661064d325bb0a2d93cfb5754d59ca7e79ddc2f9050e89`。独立 manifest 读取因 GitHub 工作目录的账号隔离中断。 `93e2a55` 将核验脚本安装到既有的受控共享目录。 [回读复跑](https://github.com/MaLaNg116/itervane/actions/runs/44899721011)

修正后以 `8edddc0ec332ddb3b3cbca6ecf059be2a1044571` 完成标准应用 OCI 复跑。独立程序读取 79,042,560 字节，重新核对归档 SHA-256 `764142bc1446369ce8f36aabdc8acafc71179aa96cd8f63c2c4c5cb49c420e92` 和同一扫描对应的 manifest `sha256:c7d44edffdd0705978982a0ea0377943d3f5327a2adbeb525a7397f3dab2a1e3`。正式复验回执为 `2be30c880c83d4cc6541de3c70a6d5a49d308c26fd4172d5bddbc00946e807d5`。健康、503 和锁漂移样例均清理完成，工作区和暂存目录为空。 [独立回读结果](https://github.com/MaLaNg116/itervane/actions/runs/44899721011/job/136832963320)

既有原稿、模板修复和 npm 修复三条原生回归全部通过，三次清理均确认并且暂存目录为空。复跑期间的代码与最终合并版本相同，差异均为导读。最终合入 `36c537fabdbc695ae1bb24f9d3cfc020ceb41ad5`。 [原生回归](https://github.com/MaLaNg116/itervane/actions/runs/44899721011/job/136832963203) · [合并提交](https://github.com/MaLaNg116/itervane/commit/36c537fabdbc695ae1bb24f9d3cfc020ceb41ad5)
