# Runner · 固定基础镜像下载导读

基于已合入 #78 的 `main`。本批固定代码版本为 `c673ddc40e710eb7dd3430a2399070d332cfd18e`。 [PR #86](https://github.com/MaLaNg116/itervane/pull/86) · [实施计划](../plans/runner-pinned-base-mirror.md)

1. 固定 Ubuntu 下载优先访问公开镜像缓存。下载失败后，从 Docker Hub 在另一临时目录准备布局。两个来源都受默认拒绝策略、固定仓库路径及同一镜像摘要约束。 [下载脚本](https://github.com/MaLaNg116/itervane/blob/c673ddc40e710eb7dd3430a2399070d332cfd18e/scripts/prepare-runner-oci-inputs.sh)
2. 将下载布局交给已有 OCI 校验，核对清单、配置、镜像层和 umoci 的摘要，校验通过后原子发布准备目录。 [离线校验](https://github.com/MaLaNg116/itervane/blob/c673ddc40e710eb7dd3430a2399070d332cfd18e/packages/runner/host/oci_layout.py)
3. Windows HTTPS 下载核对了缓存中三个固定摘要，WSL 的 Bash 语法及八项 OCI 单元通过。模拟传输覆盖缓存成功、缓存写出半成品后回退、两处都失败三种情况。本机原生下载受到网络配置影响，实际 skopeo 构造与 KVM 由托管任务验收。 [OCI 构造](https://github.com/MaLaNg116/itervane/actions/runs/44983956646) · [KVM 回归](https://github.com/MaLaNg116/itervane/actions/runs/44983956697)
