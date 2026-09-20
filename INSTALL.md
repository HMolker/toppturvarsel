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

If another app (e.g. Immich) is already reachable at
`http://<name>.tplinkdns.com:<port>/`, you don't need a new DDNS name. The
name points to your home connection. Each app on the Pi is told apart by
its **port**, so Fjällskred just needs its own port forward:

1. Check DDNS is still on: **Advanced → Network → Dynamic DNS**. The status
   should say *Connected*, with your `…tplinkdns.com` name.
2. Open **Advanced → NAT Forwarding → Virtual Servers**. You'll see the
   existing rule for the other app (e.g. port 2283 → the Pi). Add one more
   rule next to it:
   - Service type: `fjallskred`
   - External port: `8095` (your `HOST_PORT`)
   - Internal IP: the Pi's IP (the same as in the existing rule)
   - Internal port: `8095`
   - Protocol: TCP. Enable and save.

   On a **Deco** system this is in the Deco app: *More → Advanced → Port
   Forwarding → +*, with the same values.
3. The Pi's IP must not change. If the existing rule already works, it
   has a reservation. Otherwise add one under **Advanced → Network → DHCP
   Server → Address Reservation**.
4. Test from outside: turn Wi-Fi off on your phone and open
   `http://<name>.tplinkdns.com:8095/`. From inside your own Wi-Fi some
   routers don't loop back to their own DDNS name; use `http://<pi-ip>:8095`
   at home if so.

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

**From a tarball** (as before): unpack it over the folder (your `.env` and
`data/cache` are not in the archive, so they are kept) and rebuild:

```bash
tar xzf ~/toppturvarsel.tar.gz -C ~/apps
cd ~/apps/toppturvarsel && docker compose up -d --build
```

**From GitHub** (once step 11 is done):

```bash
cd ~/apps/toppturvarsel
git pull --tags
docker compose up -d --build
```

To go back to an earlier version (`CHANGELOG.md` says what each one is):

```bash
git tag -l                       # before-resorts, v2-planner, v3.8-haukeli, v4.0, ...
git checkout v3.8-haukeli
docker compose up -d --build
git checkout main                # back to the latest
```

## 11. Keeping it on GitHub

From version 4 the project lives in a GitHub repository: every version is a
commit on `main` with a tag, and GitHub runs the tests (and a Docker build)
on every push. The first push is done once, from your computer.

**On github.com:** New repository → name `fjallskred` → **Private** → do
*not* add a README, .gitignore or licence (the repo must be empty) → Create.

**On your computer**, in the folder where you unpacked
`toppturvarsel.tar.gz` (it contains the full history, `.git` included):

```bash
cd toppturvarsel
git remote add origin https://github.com/<your-user>/fjallskred.git
git push -u origin main
git push origin --tags
```

The first push asks you to sign in (a browser window, or GitHub Desktop /
the Git Credential Manager). Then open the repo's **Actions** tab: the "CI"
run should turn green within a few minutes.

**Let the Pi pull from GitHub** (optional, replaces copying tarballs). A
private repo needs a key; a *deploy key* can only read this one repo:

```bash
ssh-keygen -t ed25519 -f ~/.ssh/fjallskred_deploy -N "" -C "pi fjallskred"
cat ~/.ssh/fjallskred_deploy.pub      # copy this line
```

On GitHub: repo → Settings → Deploy keys → Add deploy key → paste, leave
"Allow write access" **off**. Then on the Pi:

```bash
cat >> ~/.ssh/config <<'CFG'
Host github-fjallskred
  HostName github.com
  User git
  IdentityFile ~/.ssh/fjallskred_deploy
CFG
cd ~/apps/toppturvarsel
git remote add origin git@github-fjallskred:<your-user>/fjallskred.git   # or: git remote set-url origin ...
git fetch origin && git branch -u origin/main main
git pull --tags
```

**New versions from Claude** arrive as a small `fjallskred-vX.Y.bundle`
file (only the new commits and tags). On your computer, in the same folder:

```bash
git pull ~/Downloads/fjallskred-vX.Y.bundle main
git fetch ~/Downloads/fjallskred-vX.Y.bundle 'refs/tags/*:refs/tags/*'
git push && git push --tags
```

and then `git pull --tags` + `docker compose up -d --build` on the Pi.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `uname -m` says `armv7l` | 32-bit Raspberry Pi OS. Node 22 images need 64-bit: reinstall with Raspberry Pi OS (64-bit), Pi 3B or newer. |
| Logs say `EACCES` / permission denied under `/app/data/cache` | `sudo chown -R 1000:1000 data/cache` and `docker compose restart`. |
| `port is already allocated` | Pick another port in step 4. |
| Container shows `unhealthy` | `docker compose logs --tail 100`. `/api/health` is unhealthy when the data is stale, i.e. refreshing has stopped working, not only when the process is down. |
| `Rejected request from RFC1918 IP to public server address` | That page comes from the **router**, not from Fjällskred: the request reached the router's own web server from inside your network. Test on mobile data with Wi-Fi off, and include `:8095` in the address. At home, use `http://<pi-ip>:8095`. |
| Works at home, not from outside | Check the port forward and fixed IP. If it still fails, your ISP may use CG-NAT (no public IPv4): ask them for a public IP, or use a tunnel (e.g. Cloudflare Tunnel or Tailscale Funnel). |
| No push arrives | Check `NTFY_TOPIC` is exactly the topic subscribed in the app, then run the test in step 7. |
| No email arrives | `MAIL_FROM` must be on a domain verified in Resend; check the Resend dashboard's logs. |
| First weeks of the season: Swedish danger levels missing | The Swedish bulletin is read from lavinprognoser.se's page and was written before a live forecast existed. On 11 December check one region against the website (see README, "Honest limitations"). |
