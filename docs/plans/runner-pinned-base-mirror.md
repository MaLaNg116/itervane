# Runner 固定基础镜像下载恢复

两次托管 KVM 发布回归在下载 Ubuntu 基础镜像时触发 Docker Hub 匿名限流，相关测试在启动发布前退出。 [#79 发布变更回归](https://github.com/MaLaNg116/itervane/actions/runs/44978105152/job/137072414244) · [#82 发布故障回归](https://github.com/MaLaNg116/itervane/actions/runs/44982452271/job/137085763977)

1. 从 Docker Hub 的公开镜像缓存优先下载固定摘要，缓存不可用时回到 Docker Hub。两个来源各自使用独立的临时 OCI 布局。
2. OCI 布局仍通过已有本地校验才能原子移入准备目录。镜像清单、配置、镜像层及 umoci 使用当前固定摘要。
3. 验收脚本语法、本地摘要下载和缓存回退，随后核对托管 OCI 构建及 Runner 回归。
