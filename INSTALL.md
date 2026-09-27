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
mkdir -p data/cache data/tracks data/photos data/auth
sudo chown -R 1000:1000 data/cache data/auth
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
box cannot be used as a relay. There is no upload; logins are optional (8b).

Plain HTTP is fine for a read-only page. With logins (8b) use HTTPS
(8c), so passwords do not cross the internet in the clear.

## 8b. Logins: premium and sneaky (v5.8)

Logins are off until `data/auth/users.csv` lists someone. Then every page
asks for a username and password, and there are two kinds of user:

| | premium | sneaky |
|---|---|---|
| Conditions map, bulletins, snow, tour list, trip planner, weather, resorts, huts | ✓ | ✓ |
| Plan a tour | everywhere | a demo within 3 km of Harahorn |
| Place search that opens new areas, forecast accuracy, tour editor, Refresh now | ✓ | "slope closed" |
| GPX download, export and import | ✓ | "slope closed" |

A sneaky user who tries a premium thing gets a popup: *Slope closed — open
for premium skiers only*.

**The demo area.** A sneaky user's Plan a tour works only from terrain the
server has already stored: the map stops 3 km from Harahorn, and nothing
they do fetches a new height. The server downloads the area itself, a
little each night (`NIGHT_SCAN_HOURS`, at most `DEMO_DAILY_POINTS` = 20 000
heights a night): the nearest 1.5 km first, the rest over the next nights.
Until then the page says how far it has come. Settings: `DEMO_*` in `.env`.

**The list.** The server needs the folder (step 2 made it, with the right
owner). Either edit `data/auth/users.csv` by hand — one user a line,
`username,kind,password`, see `deploy/users.csv.example` — or use the
command, which also makes up passwords:

```bash
cd ~/apps/fjallskred
# ten premium users, with new passwords printed once
docker compose exec toppturvarsel node src/users-cli.js add premium anna bengt cilla
# a hundred sneaky ones: list the names the same way
docker compose exec toppturvarsel node src/users-cli.js add sneaky olle eva …
docker compose exec toppturvarsel node src/users-cli.js list
# a forgotten password: a new one, printed once (their sessions end)
docker compose exec toppturvarsel node src/users-cli.js passwd anna
docker compose exec toppturvarsel node src/users-cli.js role olle premium
docker compose exec toppturvarsel node src/users-cli.js remove olle
```

- Passwords written by hand are swapped for their hash (scrypt) within half
  a minute, so the plain text does not stay on disk. At least 8 characters.
- A new password, a removed line or a changed kind takes effect at once:
  their sessions made before end.
- A login lasts 30 days (a cookie). Five wrong passwords in 15 minutes lock
  that username and that address for 15 minutes.
- `data/auth` also holds `secret`, the key the cookies are signed with.
  Delete it to log everyone out. Neither file is ever in git.
- To turn logins off again, move `users.csv` away.

## 8c. HTTPS with Caddy (v5.8)

Caddy sits in front on ports 80 and 443, gets a certificate for your
`…tplinkdns.com` name by itself and keeps it renewed, and passes each
path to its app:

- `https://<name>.tplinkdns.com/fjallskred/` → Fjällskred
- `https://<name>.tplinkdns.com/molker-hemma/` → Molker hemma
- `https://<name>.tplinkdns.com/` → a small page with the two
- Immich stays as it is, on its own port.

1. **Router**: forward external port **80** and **443** (TCP) to the Pi,
   same internal ports, next to the existing Immich rule (see 8). Nothing
   else on the Pi may use 80 or 443. The Fjällskred rule for 8095 can go
   once Caddy works.
2. **Caddy**, in a folder of its own:

   ```bash
   mkdir -p ~/apps/caddy
   cp -r ~/apps/fjallskred/deploy/caddy/. ~/apps/caddy/
   cd ~/apps/caddy
   cp .env.example .env
   nano .env        # SITE_HOST, ACME_EMAIL, FJALLSKRED_PORT=8095, MOLKER_HEMMA_PORT
   docker compose up -d
   docker compose logs -f     # wait for "certificate obtained successfully"
   ```

3. **Fjällskred**, in `~/apps/fjallskred/.env`:

   ```
   HOST_PORT=127.0.0.1:8095
   BASE_PATH=/fjallskred
   TRUST_PROXY=true
   ```

   then `docker compose up -d`. `127.0.0.1:` makes the port reachable only
   by Caddy on the Pi itself; leave it out to also keep
   `http://<pi-ip>:8095` on your own network (then set `TRUST_PROXY=false`
   if you ever forward 8095 again).
4. Open `https://<name>.tplinkdns.com/fjallskred/` from your phone on
   mobile data.

**Molker hemma at a sub-path.** Caddy strips `/molker-hemma` before passing
a request on, so the app sees the paths it always has. That works if its
pages use relative links (`style.css`, `api/…`). If it breaks — a blank
page, styles or data missing — its links start with `/`. Then either give
it its own name instead of a path (a second DDNS name or a subdomain, with
its own `… { reverse_proxy 127.0.0.1:<port> }` block in the Caddyfile), or
change its links to relative ones. Its own login is untouched.

**If the certificate fails**: check that 80 and 443 reach the Pi (the
error in the log names the one that did not), and that `SITE_HOST` is the
DDNS name exactly. Caddy retries by itself, first with Let's Encrypt and
then ZeroSSL; `data/` in the Caddy folder keeps the certificates between
restarts.

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

Once step 12 is done, updating and switching versions is two commands (see
there). The older ways still work:

**From a tarball:** unpack it over the folder (your `.env` and `data/cache`
are not in the archive, so they are kept) and build on the Pi:

```bash
tar xzf ~/toppturvarsel.tar.gz -C ~/apps
cd ~/apps/toppturvarsel && docker compose up -d --build
```

**From the source on GitHub**, building on the Pi (needs the deploy key in
step 11):

```bash
cd ~/apps/toppturvarsel
git pull --tags
git checkout v3.8-haukeli          # or main for the latest
docker compose up -d --build
```

`CHANGELOG.md` says what each version is; `git tag -l` lists them all.

## 11. Upload everything to GitHub (once, from your computer)

The repository is `github.com/HMolker/toppturvarsel` (private). The first
upload is done from your own computer, where you are signed in to GitHub.

1. Unpack `toppturvarsel.tar.gz` somewhere on your computer. It contains the
   full history (all versions, from `before-resorts` to the newest).
2. Open a terminal in that folder (`cd toppturvarsel`) and run:

   ```bash
   git remote add origin https://github.com/HMolker/toppturvarsel.git
   git push -u origin main
   git push origin --tags
   ```

   The first push opens a GitHub sign-in in the browser (Git Credential
   Manager, which comes with Git for Windows and GitHub Desktop; on a Mac,
   `brew install --cask git-credential-manager` if it asks for a password
   instead). A classic "password" does not work on GitHub; the sign-in does.

   If `git push -u origin main` is rejected with *"Updates were rejected …
   fetch first"*, the repo was created with a README. It holds nothing
   else, so replace it: `git push --force -u origin main`, then push the tags.

3. On github.com, open the repo's **Actions** tab. Two runs start:
   **CI** (the tests, a minute) and **Image** (builds the Pi's image, about
   5–10 minutes the first time). Both should turn green.

Pushing many tags at once does not start builds for them (GitHub skips
that), so only `latest` exists at first. To get an image for any other
version: **Actions → Image → Run workflow**, type e.g. `v4.0` or
`v3.8-haukeli`, **Run**.

## 12. Let the Pi run the latest or a chosen version

GitHub now stores ready-made images at `ghcr.io/hmolker/toppturvarsel`, one
per version plus `latest`. The Pi downloads instead of building, which takes
seconds instead of minutes.

**Access, once.** The repo is private, so its images are too. Pick one:

- *Simplest:* make only the **image** public. It contains the code and the
  tour list, never your `.env` or keys. On GitHub: your profile → **Packages**
  → `toppturvarsel` → **Package settings** → **Change visibility** → Public.
  The repository itself stays private.
- *Keep it private:* create a token that can only read packages (profile →
  Settings → Developer settings → Personal access tokens → **Tokens
  (classic)** → Generate, tick only `read:packages`, expiry as you like), then
  on the Pi:

  ```bash
  docker login ghcr.io -u HMolker      # paste the token as the password
  ```

**Choose the version** in `.env` on the Pi:

```
FJALLSKRED_VERSION=latest     # follow the newest
# FJALLSKRED_VERSION=v4.0.1   # or stay on one version
```

After copying a new `docker-compose.yml`, create any folder it mounts that
you do not have yet (from v4.2: `mkdir -p data/photos`).

**Update, or switch version:**

```bash
cd ~/apps/toppturvarsel
docker compose pull
docker compose up -d
```

To go back, set an older version in `.env` and run the same two commands (if
that version has no image yet, build it first under Actions → Image → Run
workflow). `docker compose up -d --build` still builds on the Pi instead,
e.g. to test a change before it is on GitHub.

The Pi only needs `docker-compose.yml` and `.env` for this; the source
folder can stay as it is. After a new `docker-compose.yml` arrives in a
release, copy it over once.

**New versions from Claude** arrive as a small `toppturvarsel-vX.Y.bundle`
(only the new commits and tags). In the folder from step 11, on your
computer:

```bash
git pull ~/Downloads/toppturvarsel-vX.Y.bundle main
git fetch ~/Downloads/toppturvarsel-vX.Y.bundle 'refs/tags/*:refs/tags/*'
git push && git push origin vX.Y
```

Pushing the new tag on its own builds its image; pushing `main` updates
`latest`. Then `docker compose pull && docker compose up -d` on the Pi.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `uname -m` says `armv7l` | 32-bit Raspberry Pi OS. Node 22 images need 64-bit: reinstall with Raspberry Pi OS (64-bit), Pi 3B or newer. |
| Logs say `EACCES` / permission denied under `/app/data/cache` | `sudo chown -R 1000:1000 data/cache` and `docker compose restart`. |
| `EACCES` under `/app/data/auth`, or users.csv never gets hashed | `sudo chown -R 1000:1000 data/auth` and `docker compose restart`. |
| Logged in, but sent back to the login page | Open the site through Caddy with the trailing slash (`…/fjallskred/`), and check `BASE_PATH=/fjallskred` in `.env`. |
| `port is already allocated` | Pick another port in step 4. |
| Container shows `unhealthy` | `docker compose logs --tail 100`. `/api/health` is unhealthy when the data is stale, i.e. refreshing has stopped working, not only when the process is down. |
| `Rejected request from RFC1918 IP to public server address` | That page comes from the **router**, not from Fjällskred: the request reached the router's own web server from inside your network. Test on mobile data with Wi-Fi off, and include `:8095` in the address. At home, use `http://<pi-ip>:8095`. |
| Works at home, not from outside | Check the port forward and fixed IP. If it still fails, your ISP may use CG-NAT (no public IPv4): ask them for a public IP, or use a tunnel (e.g. Cloudflare Tunnel or Tailscale Funnel). |
| No push arrives | Check `NTFY_TOPIC` is exactly the topic subscribed in the app, then run the test in step 7. |
| No email arrives | `MAIL_FROM` must be on a domain verified in Resend; check the Resend dashboard's logs. |
| First weeks of the season: Swedish danger levels missing | The Swedish bulletin is read from lavinprognoser.se's page and was written before a live forecast existed. On 11 December check one region against the website (see README, "Honest limitations"). |
