# Installing Fjällskred on a Raspberry Pi (Docker)

A step-by-step guide for a Raspberry Pi that already runs Docker (for
example alongside Immich). About 20 minutes, most of it waiting for the
first build.

Commands marked **computer** run on your own laptop; everything else runs
on the Pi over SSH.

---

## 0. Check the Pi

```bash
uname -m                 # must say aarch64 (64-bit). armv7l = 32-bit OS, see Troubleshooting
docker --version         # any recent version
docker compose version   # the Compose plugin, v2
```

No Docker yet? Install it and log out and back in once:

```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER
```

## 1. Copy the project to the Pi

**computer** (in the folder where you downloaded `toppturvarsel.tar.gz`):

```bash
scp toppturvarsel.tar.gz <user>@<pi-ip>:~/
```

**Pi**:

```bash
mkdir -p ~/apps
tar xzf ~/toppturvarsel.tar.gz -C ~/apps
cd ~/apps/toppturvarsel
git log --oneline | head -3      # the full history came along
```

## 2. Create the data folder

The container runs as an unprivileged user (uid 1000) and keeps its
snapshots, caches and alert history in `data/cache`. Create it yourself so
it gets the right owner:

```bash
mkdir -p data/cache data/tracks
sudo chown -R 1000:1000 data/cache
```

## 3. Configure

```bash
cp .env.example .env
nano .env
```

Set at least:

| Setting | Value |
|---|---|
| `TZ` | `Europe/Stockholm` (quiet hours follow it) |
| `NTFY_TOPIC` | a long random name, e.g. the output of `openssl rand -hex 12` prefixed with `fjallskred-` |
| `MAIL_PROVIDER` | `resend` for email, or leave `none` for push only |
| `RESEND_API_KEY` | from resend.com → API Keys |
| `MAIL_FROM` | an address on a domain you have **verified in Resend**, e.g. `fjallskred@yourdomain` |
| `MAIL_TO` | where alerts go |

Leave `PORT=8080`: that is the port *inside* the container. The port on the Pi is `HOST_PORT` (step 4).

Phone push: install the ntfy app (iOS/Android) and subscribe to exactly
the topic you put in `NTFY_TOPIC`. Anyone who knows the topic can read
your alerts, which is why it must be long and random.

## 4. Pick a port on the Pi

Immich and other apps already use ports, so give Fjällskred its own. Check
that e.g. 8095 is free (no output = free):

```bash
sudo ss -tlnp | grep ':8095 '
```

Then set it in `.env` (it stays there across updates):

```
HOST_PORT=8095
```

## 5. Build and start

```bash
docker compose up -d --build
```

The first build on a Pi takes a few minutes. Then:

```bash
docker compose ps          # STATUS should become "healthy" within ~2 min
docker compose logs -f     # Ctrl+C to stop following
```

Open `http://<pi-ip>:8095` from a computer or phone on your home network.

## 6. First data (out of season)

The service skips the avalanche and snow sources from July to October
(`SEASON_ONLY=true`), so in autumn the map starts empty. That is expected.
To fetch once anyway:

```bash
docker compose exec toppturvarsel node src/cli-refresh.js --force
```

Outside the season Varsom has no bulletins and there is little snow, so
expect mostly "not assessed". What already works in autumn: the trip
planner's forecasts, tour routes, contours and photos, and the ski resort
layer (Fnugg lists resorts year-round).

Routes are worked out from OpenStreetMap in the background, one tour every
few seconds, so for the first few minutes some tours will say "looking up".

## 7. Test the alerts

```bash
curl -X POST http://localhost:8095/api/test-alert
```

This is a dry run: it shows what would be sent and to which channels,
without sending or recording anything. The response says whether email and
ntfy are configured (`channels`).

## 8. Reach it from outside (TP-Link DDNS)

In the TP-Link router admin:

1. **Advanced → NAT Forwarding → Virtual Servers → Add**
   - Service type: `fjallskred`
   - External port: `8095`
   - Internal IP: the Pi's IP
   - Internal port: `8095`
   - Protocol: TCP
2. Make sure the Pi has a fixed IP (Advanced → Network → DHCP Server →
   Address Reservation), otherwise the forwarding breaks when it changes.

Then open `http://<your-ddns-name>:8095` from your phone on mobile data
(not Wi-Fi) to test it from outside.

What the public can do: read the page, and press "Refresh now" (limited to
once per 10 minutes, `REFRESH_COOLDOWN_MINUTES`). Routes, forecasts,
terrain, photos and map tiles are only served for the listed tours, so the
box cannot be used as a relay. There is no login and no upload.

Plain HTTP is fine for a read-only page. If you later want HTTPS, put a
reverse proxy in front (Caddy or Nginx Proxy Manager, both run in Docker)
and forward 443 to it instead of 8095.

## 9. Everyday use

```bash
cd ~/apps/toppturvarsel
docker compose logs --tail 50        # what happened lately
docker compose restart               # after editing .env
docker compose down                  # stop
docker compose up -d                 # start again
```

It restarts by itself after a reboot (`restart: unless-stopped`).

Backup: `data/cache` holds the snapshot history and the alert ledger;
`.env` holds your keys. Those two are all you need to keep.

## 10. Updating, and going back

With a new `toppturvarsel.tar.gz`, unpack it over the folder (your `.env`
and `data/cache` are not in the archive, so they are kept) and rebuild:

```bash
tar xzf ~/toppturvarsel.tar.gz -C ~/apps
cd ~/apps/toppturvarsel && docker compose up -d --build
```

To go back to an earlier version:

```bash
git tag -l                       # before-resorts, v1-resorts-music, v2-planner, ...
git checkout v2-planner
docker compose up -d --build
git checkout master              # back to the latest
```

## Troubleshooting

| Symptom | Fix |
|---|---|
| `uname -m` says `armv7l` | 32-bit Raspberry Pi OS. Node 22 images need 64-bit: reinstall with Raspberry Pi OS (64-bit), Pi 3B or newer. |
| Logs say `EACCES` / permission denied under `/app/data/cache` | `sudo chown -R 1000:1000 data/cache` and `docker compose restart`. |
| `port is already allocated` | Pick another port in step 4. |
| Container shows `unhealthy` | `docker compose logs --tail 100`. `/api/health` is unhealthy when the data is stale, i.e. refreshing has stopped working, not only when the process is down. |
| Works at home, not from outside | Check the port forward and fixed IP. If it still fails, your ISP may use CG-NAT (no public IPv4): ask them for a public IP, or use a tunnel (e.g. Cloudflare Tunnel or Tailscale Funnel). |
| No push arrives | Check `NTFY_TOPIC` is exactly the topic subscribed in the app, then run the test in step 7. |
| No email arrives | `MAIL_FROM` must be on a domain verified in Resend; check the Resend dashboard's logs. |
| First weeks of the season: Swedish danger levels missing | The Swedish bulletin is read from lavinprognoser.se's page and was written before a live forecast existed. On 11 December check one region against the website (see README, "Honest limitations"). |
