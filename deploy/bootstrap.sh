#!/usr/bin/env bash
#
# One-shot server setup for the MSVA demo on a fresh Ubuntu VPS (Hostinger KVM2).
#
# Run this AS ROOT, from the repo, after you have cloned it and created the env
# files (see steps printed at the end if you haven't):
#
#   sudo bash deploy/bootstrap.sh
#
# It installs Node 22 + pnpm + pm2 + Caddy, builds everything, publishes the web
# app, starts the backend under pm2, and configures Caddy (HTTPS) for the domain.
set -euo pipefail

DOMAIN="msva.maplestudios.co.in"
REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# The web app is served in place from its build output. This works whether the
# repo lives at /var/www/msva or somewhere like /opt/msva — Caddy's root is set
# to this path below, so the repo source/.env are never exposed.
WEB_DIST="${REPO_DIR}/apps/web/dist"

if [[ "${EUID}" -ne 0 ]]; then
  echo "Please run as root:  sudo bash deploy/bootstrap.sh" >&2
  exit 1
fi

echo "==> Repo: ${REPO_DIR}"
cd "${REPO_DIR}"

# --- 1. System packages --------------------------------------------------------
echo "==> Installing base packages"
apt-get update -y
apt-get install -y curl git debian-keyring debian-archive-keyring apt-transport-https

# --- 2. Node 22 ----------------------------------------------------------------
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | cut -dv -f2 | cut -d. -f1)" -lt 22 ]]; then
  echo "==> Installing Node 22"
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi
echo "    node $(node -v)"

# --- 3. pnpm (via corepack) + pm2 ---------------------------------------------
corepack enable || true
if ! command -v pm2 >/dev/null 2>&1; then
  echo "==> Installing pm2"
  npm install -g pm2
fi

# --- 4. Caddy ------------------------------------------------------------------
if ! command -v caddy >/dev/null 2>&1; then
  echo "==> Installing Caddy"
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  apt-get update -y
  apt-get install -y caddy
fi

# --- 5. Env files --------------------------------------------------------------
copy_if_missing() { [[ -f "$2" ]] || { cp "$1" "$2"; echo "    created $2 (EDIT IT)"; }; }
copy_if_missing deploy/api.env.example       apps/api/.env
copy_if_missing deploy/telephony.env.example apps/telephony/.env
copy_if_missing deploy/web.env.example       apps/web/.env

KEY_MISSING=0
grep -q '__PUT_YOUR_SARVAM_KEY_HERE__' apps/api/.env apps/telephony/.env 2>/dev/null && KEY_MISSING=1

# --- 6. Build ------------------------------------------------------------------
echo "==> Installing dependencies"
pnpm install --frozen-lockfile
echo "==> Building"
pnpm --filter @msva/shared build
pnpm --filter @msva/api build
pnpm --filter @msva/telephony build
pnpm --filter @msva/web build

echo "==> Web build is at ${WEB_DIST} (served in place by Caddy)"
[[ -f "${WEB_DIST}/index.html" ]] || { echo "ERROR: web build missing at ${WEB_DIST}" >&2; exit 1; }

# --- 7. Backend under pm2 ------------------------------------------------------
echo "==> Starting backend (pm2)"
pm2 start deploy/ecosystem.config.cjs || pm2 reload deploy/ecosystem.config.cjs
pm2 save
pm2 startup systemd -u root --hp /root >/dev/null 2>&1 || true

# --- 8. Caddy (HTTPS + reverse proxy) -----------------------------------------
echo "==> Configuring Caddy (serving ${WEB_DIST})"
cp deploy/Caddyfile /etc/caddy/Caddyfile
# Point Caddy's static root at this repo's build output, wherever the repo lives.
sed -i "s#root \* .*#root * ${WEB_DIST}#" /etc/caddy/Caddyfile
systemctl reload caddy || systemctl restart caddy

echo
echo "============================================================"
echo " Done. Backend on pm2, Caddy serving https://${DOMAIN} from ${WEB_DIST}"
echo "------------------------------------------------------------"
pm2 status
echo "------------------------------------------------------------"
if [[ "${KEY_MISSING}" -eq 1 ]]; then
  echo " ACTION NEEDED: add your real SARVAM_API_KEY in:"
  echo "   apps/api/.env  and  apps/telephony/.env"
  echo "   then:  pm2 reload all"
fi
echo " Make sure DNS A record ${DOMAIN} -> this server's IP exists,"
echo " and ports 80 + 443 are open, before the cert can be issued."
echo " Then open: https://${DOMAIN}"
echo "============================================================"
