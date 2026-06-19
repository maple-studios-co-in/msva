# Deploying MSVA to a Hostinger KVM2 (msva.maplestudios.co.in)

This is a native deploy (no Docker): **Node 22 + pnpm**, the two backend
services under **pm2**, the web build as static files, and **Caddy** for
automatic HTTPS + reverse proxy. Target host: Hostinger KVM2 (2 vCPU / 8 GB),
Ubuntu 22.04 or 24.04.

> Why HTTPS is mandatory: the in-browser Live Call needs microphone access and a
> `wss://` WebSocket. Browsers block both on non-secure origins, so the demo
> only works over `https://msva.maplestudios.co.in`, not over a bare IP.

---

## 0. DNS + firewall (do this first)

1. In your DNS (where maplestudios.co.in is managed), add an **A record**:
   `msva` → `<your KVM2 public IP>`. Wait for it to resolve
   (`dig +short msva.maplestudios.co.in` should return the IP).
2. Open ports **80** and **443** (Hostinger panel firewall / `ufw allow 80,443/tcp`).
   Caddy needs 80+443 to obtain and renew the TLS cert.

## 1. Install the toolchain (on the server, as root or with sudo)

```bash
# Node 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs git
# pnpm (via corepack) + pm2
sudo corepack enable
sudo npm install -g pm2

# Caddy (official repo)
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

## 2. Get the code

```bash
sudo mkdir -p /opt/msva && sudo chown $USER:$USER /opt/msva
git clone <YOUR_REPO_URL> /opt/msva
cd /opt/msva
```

## 3. Configure environment + secrets

```bash
cp deploy/api.env.example       apps/api/.env
cp deploy/telephony.env.example apps/telephony/.env
cp deploy/web.env.example       apps/web/.env
```

Edit **`apps/api/.env`** and **`apps/telephony/.env`** and set your real
`SARVAM_API_KEY` in both. Leave `AGENT_LLM=off` for now (see §7 for the AI brain
trade-off). `apps/web/.env` is already correct for this domain.

## 4. Build

```bash
cd /opt/msva
pnpm install --frozen-lockfile

# Build shared types first, then the services and the web app.
pnpm --filter @msva/shared build
pnpm --filter @msva/api build
pnpm --filter @msva/telephony build
pnpm --filter @msva/web build      # reads apps/web/.env — must exist first

# Publish the static web build where Caddy serves it.
sudo mkdir -p /var/www/msva
sudo rm -rf /var/www/msva/*
sudo cp -r apps/web/dist/* /var/www/msva/
```

## 5. Run the backend under pm2

```bash
cd /opt/msva
pm2 start deploy/ecosystem.config.cjs
pm2 save
pm2 startup     # run the command it prints, to start on boot
pm2 status      # msva-api (4100) + msva-telephony (4200) should be "online"
```

Quick local check before TLS:

```bash
curl -s localhost:4100/health     # {"ok":true,...}
curl -s localhost:4200/health     # {"ok":true,...}
```

## 6. Reverse proxy + HTTPS (Caddy)

```bash
sudo cp /opt/msva/deploy/Caddyfile /etc/caddy/Caddyfile
sudo systemctl reload caddy
sudo systemctl status caddy --no-pager     # active (running)
```

Caddy will fetch the TLS cert on first request (give it ~30 s). Then open
**https://msva.maplestudios.co.in** and:

- **Live Call** → pick a voice → **Call**, allow the mic, talk. The agent should
  reply in voice. (First TLS load can take a moment.)
- Click **Demo failsafe** to confirm the pre-recorded clip plays.

---

## 7. The AI brain (recommendation)

This is the one real trade-off on a CPU-only KVM2.

- **`AGENT_LLM=off` (default, recommended for the live demo).** Instant
  deterministic Hinglish replies + real tool calls (ticket / transfer /
  inventory) + the failsafe clip. Zero latency risk. The only thing you lose is
  model-driven `lookup_order` phrasing.
- **`AGENT_LLM=on` (real local model).** Genuine LLM replies and model-chosen
  order lookups, but token generation on 2 vCPU adds a few seconds per turn. If
  you want this:

  ```bash
  curl -fsSL https://ollama.com/install.sh | sh
  ollama pull llama3.2:3b          # small + fast; good tool-calling
  ```
  Then in `apps/api/.env` set `AGENT_LLM=on`, `OLLAMA_MODEL=llama3.2:3b`,
  `OLLAMA_TIMEOUT_MS=30000`, and `pm2 reload msva-api`. Rehearse a few turns; if
  latency feels bad on the day, flip back to `AGENT_LLM=off` and `pm2 reload`.

> Suggested plan: demo with `AGENT_LLM=off` for a crisp, reliable experience, and
> keep the **Demo failsafe** button as the safety net. Turn the LLM on only if a
> rehearsal shows acceptable latency.

## 8. Updating after a code change

```bash
cd /opt/msva && git pull
pnpm install --frozen-lockfile
pnpm --filter @msva/shared build
pnpm --filter @msva/api build
pnpm --filter @msva/telephony build
pnpm --filter @msva/web build
sudo rm -rf /var/www/msva/* && sudo cp -r apps/web/dist/* /var/www/msva/
pm2 reload all
```

## 9. The demo failsafe clip

- Audio lives at `apps/api/assets/demo-failsafe.mp3`; the matching on-screen
  caption + outcome come from `data/demo-failsafe.json`.
- **Set the `transcript` in that JSON to the exact words spoken in the clip** so
  the caption that types out on screen matches the audio. Then `pm2 reload msva-api`.
- To swap the clip, replace the mp3 and reload.

## 10. Troubleshooting

- **Mic blocked / "Could not start call"** → you're not on `https://` with a
  valid cert. Confirm the padlock; check `sudo journalctl -u caddy -e`.
- **Call connects but no agent voice** → `SARVAM_API_KEY` missing/invalid in
  `apps/api/.env` and `apps/telephony/.env`. Check `pm2 logs msva-telephony`.
- **WebSocket fails** → confirm Caddy is proxying `/browser` and
  `apps/web/.env` has `VITE_TELEPHONY_WS_URL=wss://msva.maplestudios.co.in`
  (rebuild web if you changed it).
- **502 / nothing loads** → `pm2 status`; `curl localhost:4100/health`.
- **Agent always uses fallback even with AGENT_LLM=on** → Ollama too slow /
  timing out; raise `OLLAMA_TIMEOUT_MS` or use a smaller model.

## 11. Real phone calls (optional)

The same backend handles live PSTN calls via Exotel/Twilio — Caddy already
proxies `/voice` and `/exotel`. See [docs/live-call.md](docs/live-call.md) for
wiring a DID. Not required for the in-browser demo.
