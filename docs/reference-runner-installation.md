# 参考 KVM Runner

参考控制面和执行侧使用同一台 Ubuntu 24.04 x86_64 主机上的独立账号。Runner 通过专用 `qemu:///session` 管理一次性虚拟机，Worker 仅连接受限 Unix socket。镜像、临时工作区和 OCI 档案分别存放。 [参考控制面安装](reference-installation.md) · [Runner 计划](plans/p5-reference-runner.md) · [libvirt 会话](https://libvirt.org/uri.html#qemu)

## 准备宿主与输入

从同一个固定 Itervane 版本检出并安装锁定的 Node 24 与 pnpm 依赖。宿主准备 KVM、QEMU、libvirt、`python3-libvirt`、`gdisk`、`guestfs-tools`、`python3-pip`、`skopeo` 和 `jq`。在可信维护者侧使用参考控制面的 Docker 准备固定输入。保留发行版的 libvirt 与 AppArmor 策略。执行 `sudo /usr/bin/python3 -I -B packages/runner/host/kvm_preflight.py`，核对报告为 `vm_descriptor_created`。 `/dev/kvm` 由 kvm 组控制。

在干净参考宿主上创建专用账号。将维护者使用的可信 checkout 放在该 Worker 可读的路径。

```sh
sudo useradd --system --user-group --groups kvm --create-home \
  --home-dir /home/itervane-runner --shell /usr/sbin/nologin itervane-runner
sudo useradd --system --user-group --groups itervane-runner --no-create-home \
  --shell /usr/sbin/nologin itervane-worker
```

Worker 的补充组用于连接 socket，控制器仍核对登记 UID。维护者在可信侧准备离线输入，保留本次扫描数据库时间与 SHA-256。以下是已支持的标准 Web 构建与 JavaScript、TypeScript 规则配置。

```sh
inputs=$(mktemp -d)
runner_state=/var/lib/itervane/runner
sealed_dir="$runner_state/image"
pnpm exec tsx scripts/prepare-runner-inspection.ts "$inputs/itervane-inspection"
bash scripts/prepare-runner-oci-inputs.sh "$inputs/itervane-oci-inputs"
oci_sha=$(sha256sum < "$inputs/itervane-oci-inputs/inputs.json" | cut -d' ' -f1)
pnpm exec tsx scripts/prepare-runner-build-dependencies.ts "$inputs/itervane-build-inputs" "$oci_sha"
/usr/bin/python3 scripts/prepare-runner-rule-engine.py "$inputs/itervane-semgrep"
sudo install -d -m 0711 -o root -g root "$runner_state"
sudo install -d -m 0710 -o root -g kvm "$sealed_dir"
sudo env ITERVANE_RULE_ENGINE_INPUTS="$inputs/itervane-semgrep" \
  bash fixtures/runner/prepare-probe-image.sh "$sealed_dir" "$inputs/itervane-inspection" \
  "$inputs/itervane-build-inputs" "$inputs/itervane-oci-inputs"
sudo chgrp kvm "$sealed_dir/probe.raw"
sudo chmod 0440 "$sealed_dir/probe.raw"
sudo cat "$sealed_dir/image.json" > "$inputs/image.json"
```

## 启动并绑定 Worker

选择已登记的 HTTPS Git 仓库。Controller 逐个校验登记源，Guest 内的执行继续使用固定快照、受控源码入口和离线规则。

```sh
image_sha=$(jq -er '.rawSha256' "$inputs/image.json")
sudo bash packages/runner/ops/start-reference-runner.sh "$runner_state" "$sealed_dir/probe.raw" "$image_sha" \
  itervane-runner itervane-worker https://github.com/MaLaNg116/itervane.git > "$inputs/runner.env"
pnpm --silent reference:runner-profile "$inputs/image.json" "$inputs/itervane-inspection/inputs.json" \
  "$inputs/itervane-build-inputs/profile.json" "$inputs/itervane-oci-inputs/inputs.json" \
  "$inputs/itervane-semgrep/inputs.json" > "$inputs/profile.env"
```

启动命令重新计算镜像摘要，并以指定 Worker UID 确认 Controller 就绪后写出连接配置。将 `runner.env` 和 `profile.env` 追加到为专用 Worker 准备的运行配置。保留原来的低权限 `DATABASE_URL`，通过受管凭证配置 Anthropic 或 OpenAI 协议和用于审计的模型。配置文件只赋予 Worker 读取权限。启用完整审计与复验时使用同一组镜像和输入指纹。

从可信 checkout 以 Worker 账号启动 `node --env-file=<Worker 配置> --import tsx packages/control-plane/src/entries/worker.ts`。对于容器发布和重启，沿用各自登记的 Komodo、Whiskers、Registry、受保护入口和审批。 [发布 Worker 安装](reviews/p2-e-release-installation.md) · [重启配置](control-plane-restart.md) · [应用受保护入口](../fixtures/ingress/reference/README.md)

维护时先停 Worker，核对在途任务，再按顺序停止 `itervane-reference-runner.service`、`itervane-reference-libvirt.service`。当前使用 transient systemd 单元，主机重启后按同一绑定重新启动。安装器拒绝覆盖正在运行的会话。临时域或套接字残留时应先核对专属会话的状态。持久档案目录为 `$runner_state/artifacts`，与控制面和版本记录同批备份。 [备份恢复](control-plane-backup.md) · [systemd 执行配置](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)

## English

Use the pinned Itervane checkout and an Ubuntu 24.04 x86_64 Linux host with a usable KVM device. Create the dedicated Runner and Worker accounts and prepare the sealed guest with the commands above. The Runner account owns its session and runtime directories. The Worker connects over the Unix socket and each request is bound to its registered UID.

Use `start-reference-runner.sh` with the canonical image path, verified image SHA-256 and exact registered repository URLs. Start the Worker with the emitted connection and profile settings, scoped database authentication and managed model credentials. Keep the release and operations services scoped to their existing enrollment and approval configuration. Stop consumers before stopping the controller and then libvirt. Reapply startup after a host reboot. Keep the retained OCI archive directory with the matching control-plane backup.
