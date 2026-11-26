# P5-B2 · 参考安装接入独立 KVM Runner

参考控制面已从空目录启动。本批把原来的托管 Runner 会话启动逻辑整理为维护者可执行的宿主安装，并在托管场景复用同一路径。采用 Ubuntu 24.04 x86_64、KVM 和专用 `qemu:///session`，继续使用已验证的 Controller、固定镜像和现有执行闸门。 [P5-B1](p5-reference-install.md) · [#162](https://github.com/MaLaNg116/itervane/pull/162)

1. 复用已有脚本准备和封存扫描、构建、OCI 与规则输入。安装者显式核对 raw 镜像 SHA-256，分开保留镜像、Runner 临时工作区和 OCI 档案。
2. 以独立无登录账号启动 libvirt 会话及 Controller。Worker 通过专用 Unix socket 按 UID 查询和派发。Worker 不加入 kvm、Docker 或 libvirt 管理组。Controller 保留无新特权、进程核对和镜像校验。
3. 提供双语安装步骤，生成 Worker 连接配置，使用真实授权查询确认当前镜像和工作区。托管 KVM 的正式初检、复验、OCI 和规则样例继续使用同一套生命周期，并核对临时域回收。发布与运维仍沿用原生审批和真实读回。
