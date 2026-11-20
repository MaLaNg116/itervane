#!/bin/sh
set -eu

dpkg --install /var/tmp/itervane-probe-liburing.deb /var/tmp/itervane-probe-agent.deb
rm -- /var/tmp/itervane-probe-liburing.deb /var/tmp/itervane-probe-agent.deb
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
