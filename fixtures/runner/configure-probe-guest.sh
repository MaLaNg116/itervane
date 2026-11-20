#!/bin/sh
set -eu

dpkg --install /var/tmp/itervane-probe-liburing.deb /var/tmp/itervane-probe-agent.deb
rm -- /var/tmp/itervane-probe-liburing.deb /var/tmp/itervane-probe-agent.deb
test -x /usr/bin/python3
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin itervane-job
useradd --system --user-group --no-create-home --shell /usr/sbin/nologin itervane-workload
install -Dm 0644 /var/tmp/itervane-guest-job.py /usr/local/libexec/itervane-guest-job.py
install -Dm 0644 /var/tmp/verify-guest-workload.py /usr/local/libexec/itervane-probe-workload.py
rm -- /var/tmp/itervane-guest-job.py /var/tmp/verify-guest-workload.py
install -d -m 0755 /etc/itervane-probe
(umask 077; printf '%s\n' 'synthetic protected guest marker' >/etc/itervane-probe/protected.marker)
cat >/etc/udev/rules.d/60-itervane-guest-job.rules <<'EOF'
SUBSYSTEM=="virtio-ports", ATTR{name}=="org.itervane.runner.job.0", OWNER="itervane-job", MODE="0600", TAG+="systemd", ENV{SYSTEMD_WANTS}+="itervane-guest-job.service"
EOF
cat >/etc/systemd/system/itervane-guest-job.service <<'EOF'
[Unit]
Requires=qemu-guest-agent.service
BindsTo=itervane-probe-workload.service
After=qemu-guest-agent.service itervane-probe-workload.service

[Service]
ExecStart=/usr/bin/python3 -I -B /usr/local/libexec/itervane-guest-job.py
User=itervane-job
Group=itervane-job
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateNetwork=true
RestrictAddressFamilies=AF_UNIX
DevicePolicy=closed
DeviceAllow=/dev/virtio-ports/org.itervane.runner.job.0 rw
MemoryMax=96M
TasksMax=4
RuntimeMaxSec=95
UMask=0077
EOF
cat >/etc/systemd/system/itervane-probe-workload.service <<'EOF'
[Unit]
Requires=qemu-guest-agent.service
After=qemu-guest-agent.service

[Service]
Type=notify
NotifyAccess=main
TimeoutStartSec=12
ExecStart=/usr/bin/python3 -I -B /usr/local/libexec/itervane-probe-workload.py
User=itervane-workload
Group=itervane-workload
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateNetwork=true
RestrictAddressFamilies=AF_UNIX
DevicePolicy=closed
StateDirectory=itervane-probe-workload
StateDirectoryMode=0700
RuntimeDirectory=itervane-probe-workload
RuntimeDirectoryMode=0755
MemoryMax=64M
TasksMax=4
LimitFSIZE=65536
RuntimeMaxSec=110
UMask=0077
EOF
install -d -m 0755 /etc/qemu /etc/systemd/system/multi-user.target.wants
cat >/etc/qemu/qemu-ga.conf <<'EOF'
[general]
allow-rpcs=guest-sync,guest-sync-delimited,guest-ping,guest-info
EOF
touch /etc/cloud/cloud-init.disabled
for unit in ssh.service ssh.socket systemd-networkd-wait-online.service systemd-networkd-wait-online@.service; do
  ln -sfn -- /dev/null "/etc/systemd/system/$unit"
done
test -f /usr/lib/systemd/system/qemu-guest-agent.service
ln -sfn -- /usr/lib/systemd/system/qemu-guest-agent.service \
  /etc/systemd/system/multi-user.target.wants/qemu-guest-agent.service

# Make the heartbeat contingent on the trusted image's observation of its
# own device profile and a disk that has not been booted by this probe.
install -d -m 0755 /usr/local/libexec /etc/systemd/system/qemu-guest-agent.service.d
cat >/usr/local/libexec/itervane-probe-check <<'EOF'
#!/bin/sh
set -eu

set -- /sys/class/net/*
test "$#" -eq 1
test "$1" = /sys/class/net/lo
test "$(cat /sys/devices/system/cpu/online)" = 0-1
awk '$1 == "MemTotal:" { ok = ($2 >= 1536 * 1024 && $2 <= 2048 * 1024) } END { exit !ok }' /proc/meminfo
read -r sectors </sys/class/block/vda/size
test "$sectors" -gt 0
test "$sectors" -le 16777216

install -d -m 0700 /var/lib/itervane-probe
marker=/var/lib/itervane-probe/booted
test ! -e "$marker"
(set -C; printf 'booted\n' >"$marker")
sync -f "$marker"
EOF
cat >/etc/systemd/system/qemu-guest-agent.service.d/itervane-probe.conf <<'EOF'
[Service]
ExecStartPre=/bin/sh /usr/local/libexec/itervane-probe-check
EOF
