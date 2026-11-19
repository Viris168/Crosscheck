#!/usr/bin/env bash
# One-time (idempotent) setup of a fresh Ubuntu LTS VPS. Run as root:
#
#   scp infra/scripts/bootstrap.sh root@VPS:/root/ && ssh root@VPS \
#     'DEPLOY_PUBKEY="ssh-ed25519 AAAA... you@laptop" bash /root/bootstrap.sh'
#
# Does: deploy user (SSH key only, docker group), sshd hardening (no passwords, no root login),
# UFW 22/80/443, Docker Engine + compose plugin, unattended-upgrades, fail2ban, /opt/app,
# nightly backup cron, Docker log rotation defaults. Safe to re-run.
#
# Env:
#   DEPLOY_USER    default deploy
#   DEPLOY_PUBKEY  public key(s) to authorize for DEPLOY_USER (falls back to root's authorized_keys)
#   APP_DIR        default /opt/app
#   SSH_PORT       default 22
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_DIR="${APP_DIR:-/opt/app}"
SSH_PORT="${SSH_PORT:-22}"
log() { echo "[bootstrap] $*"; }

[[ $EUID -eq 0 ]] || { echo "run as root" >&2; exit 1; }
. /etc/os-release
[[ "${ID:-}" == ubuntu ]] || { echo "expects Ubuntu (found ${ID:-unknown})" >&2; exit 1; }
export DEBIAN_FRONTEND=noninteractive

log "packages"
apt-get update -q
apt-get install -y -q ca-certificates curl gnupg ufw fail2ban unattended-upgrades cron gzip rsync

log "deploy user: $DEPLOY_USER"
if ! id "$DEPLOY_USER" >/dev/null 2>&1; then
  adduser --disabled-password --gecos "" "$DEPLOY_USER"
fi
passwd -l "$DEPLOY_USER" >/dev/null # key-only
install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/$DEPLOY_USER/.ssh"
AUTH="/home/$DEPLOY_USER/.ssh/authorized_keys"
touch "$AUTH"
if [[ -n "${DEPLOY_PUBKEY:-}" ]]; then
  while IFS= read -r key; do
    [[ -z "$key" ]] && continue
    grep -qxF "$key" "$AUTH" || echo "$key" >> "$AUTH"
  done <<< "$DEPLOY_PUBKEY"
elif [[ -s /root/.ssh/authorized_keys ]]; then
  while IFS= read -r key; do
    grep -qxF "$key" "$AUTH" || echo "$key" >> "$AUTH"
  done < /root/.ssh/authorized_keys
fi
chown "$DEPLOY_USER:$DEPLOY_USER" "$AUTH"; chmod 600 "$AUTH"
if [[ ! -s "$AUTH" ]]; then
  echo "no SSH key for $DEPLOY_USER (set DEPLOY_PUBKEY) — refusing to disable password login" >&2
  exit 1
fi

log "sshd: keys only, no root login"
install -d /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/10-hardening.conf <<CONF
Port $SSH_PORT
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers $DEPLOY_USER
CONF
sshd -t
systemctl reload ssh 2>/dev/null || systemctl reload sshd

log "firewall"
ufw default deny incoming >/dev/null
ufw default allow outgoing >/dev/null
ufw allow "$SSH_PORT/tcp" >/dev/null
ufw allow 80/tcp >/dev/null
ufw allow 443/tcp >/dev/null
ufw allow 443/udp >/dev/null # HTTP/3
ufw --force enable >/dev/null
# Note: Docker-published ports bypass UFW. Only caddy publishes public ports; the Inngest
# dashboard is bound to 127.0.0.1 in compose.prod.yml.

log "fail2ban (sshd)"
cat > /etc/fail2ban/jail.d/sshd.local <<CONF
[sshd]
enabled = true
port = $SSH_PORT
maxretry = 5
bantime = 1h
CONF
systemctl enable --now fail2ban >/dev/null
systemctl restart fail2ban

log "unattended-upgrades"
cat > /etc/apt/apt.conf.d/20auto-upgrades <<'CONF'
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
APT::Periodic::AutocleanInterval "7";
CONF
systemctl enable --now unattended-upgrades >/dev/null

log "docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu ${UBUNTU_CODENAME:-$VERSION_CODENAME} stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -q
  apt-get install -y -q docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
fi
# Default log rotation for every container (compose.prod.yml also sets it per service).
if [[ ! -f /etc/docker/daemon.json ]]; then
  cat > /etc/docker/daemon.json <<'CONF'
{
  "log-driver": "json-file",
  "log-opts": { "max-size": "10m", "max-file": "5" }
}
CONF
  systemctl restart docker
fi
systemctl enable --now docker >/dev/null
usermod -aG docker "$DEPLOY_USER"

log "app dir: $APP_DIR"
install -d -m 750 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$APP_DIR" "$APP_DIR/backups" "$APP_DIR/.deploy"

log "nightly backup cron (03:15 UTC)"
cat > /etc/cron.d/ai-review-backup <<CONF
# Runs once infra/ has been deployed to $APP_DIR (first deploy).
CRON_TZ=UTC
15 3 * * * $DEPLOY_USER [ -x $APP_DIR/infra/scripts/backup.sh ] && $APP_DIR/infra/scripts/backup.sh >> $APP_DIR/backups/backup.log 2>&1
CONF
chmod 644 /etc/cron.d/ai-review-backup

log "done. Next: put the app env in $APP_DIR/.env (chmod 600, owner $DEPLOY_USER) — see docs/deploy.md"
