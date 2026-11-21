# P2-D3-C3-A · 固定 OCI 输入 Review Guide

本批基于 [客体 HTTP 复验 #29](https://github.com/MaLaNg116/itervane/pull/29)，固定后续候选镜像的 Ubuntu 24.04 amd64 基底与 umoci 0.6.0。首轮可复跑代码为 `b8936d7db950866c036a1414d60db6ed6ae34379`。 [C3 实施计划](../plans/p2-d3-c3-final-image.md)

1. `8d7a50d` 从公开来源取固定 manifest。Skopeo 拷贝 OCI 布局后，核对 manifest、config、层、平台和 umoci 发布摘要。文件读取有边界，拒绝外部 blob、替换摘要和链接，校验通过后发布到独立输入目录。 [输入准备](../../scripts/prepare-runner-oci-inputs.sh) · [OCI 校验](../../packages/runner/host/oci_layout.py)
2. `a784b4b` 将同一组可信测试字节重复封装为两层 OCI，再解包读取新增内容，确认数字 UID/GID 配置与两次 manifest 地址一致。 [实测入口](../../fixtures/runner/verify-oci-inputs.sh)
3. `b8936d7` 在托管 Linux 保存输入、试验镜像和固定代码版本三份证据。 [工作流](../../.github/workflows/oci-inputs.yml)

| 实测项 | 结果 |
| --- | --- |
| 官方 Ubuntu 24.04 amd64 | 上游和本地 OCI manifest 均为 `sha256:9a04f13b3f80ef056361e30868593b1cfd2279fe19e4081cb93a90bf56819d6a` |
| 封装输入回执 SHA-256 | `45aaac6b11563e7a0265e4fd3e690677d879946a7b57f8c648e275409275ab43` |
| 可信试验镜像 | 重复封装一致，OCI manifest 为 `sha256:b455c59a241dd1ca2873dfd261948a3a8b04c3cb00f562563141baf39e6481ea`，解包文件逐字节匹配 |
| 回归 | WSL 执行 56 项宿主测试，覆盖 blob 改写、摘要替换、符号链接、硬链接、外部 URL 和错误平台 |

托管 Linux 固定版本 `5424c982bb77cd144d3d186033e9f706e82da23f` 的三个证据文件已下载复核，封装输入和试验镜像摘要与 WSL 实测一致。 [托管 OCI Inputs](https://github.com/MaLaNg116/itervane/actions/runs/44896141493)

同一代码的既有 [KVM 原生回归](https://github.com/MaLaNg116/itervane/actions/runs/44896141483) 三组通过。原始候选和两种修复路径均确认退出清理，下载证据的源码指纹为 `e083e984ec4c7f2fd86e267847986a6686e7b9e59f24e128d32a9191eaaa2d22`，与本地重算一致。已通过 `ea43d6a1b2896f059bb0a68518a457a880e4b92c` 合入 main。

实际候选的镜像封装及独立扫描进入 C3-B，产物持久化交接进入 C3-C。本批只处理公开基底与可信测试材料。 [OCI 布局规范](https://github.com/opencontainers/image-spec/blob/v1.1.1/image-layout.md) · [umoci 0.6.0 发布](https://github.com/opencontainers/umoci/releases/tag/v0.6.0)
