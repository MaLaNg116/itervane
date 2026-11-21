# P2-D3-C3-C · OCI 产物保留 Review Guide

本批依赖 [客体镜像和扫描 #31](https://github.com/MaLaNg116/itervane/pull/31)，运行代码首版为 `5e7147afd2cd14f57132a99d9747c3968bca11e8`。 [本批计划](../plans/p2-d3-c3-oci-artifacts.md)

1. `52f2b2b` 将留存意图、格式、SHA-256 和字节数绑定到实际复验回执。当前租约由已有正式事务校验，数据库拒绝缺失已申请的制品证据。 [制品契约](../../packages/contracts/src/qualified-standard-image.ts) · [事务迁移](../../packages/control-plane/migrations/0024_formal_oci_artifact_receipt.sql)
2. `8eaf665` 在客体内归档已经 Trivy 核验的 OCI 布局。宿主控制器仅在申请的会话接收有界字节分块，流式核验 SHA-256 与长度。临时文件等 VM 清理后才按内容地址原子保留，校验既有地址并去重。 [镜像归档](../../packages/runner/host/oci_guest.py) · [宿主存储](../../packages/runner/host/oci_artifacts.py)
3. `5e7147a` 用独立读取程序复算实际存储归档的 manifest。GitHub 只保留摘要和回执，平台运行程序在接收归档时保持字节流处理。 [独立核验](../../fixtures/runner/verify-stored-oci.py)

TypeScript、65 项宿主测试和 PostgreSQL 四种证据专项已通过。宿主对照覆盖截断、改写、取消中的流、相同制品竞争和既有地址损坏。本机可信 OCI 试验通过归档写入和独立 manifest 读取，正式标准候选的托管 KVM 传输结果待归档。后续 P2-E 用同一内容摘要准备真实人审发布。
