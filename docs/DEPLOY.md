# Running a public instance

This is how abtune.com runs: one small Linux server, the app in Docker, and one way in from the
internet. Everything lives in [`deploy/`](../deploy). Pick the way in with `COMPOSE_PROFILES` in
`deploy/.env`:

- **`caddy`** (abtune.com today): the domain points at the server, and [Caddy](https://caddyserver.com)
  serves HTTPS on ports 80 and 443, with certificates from Let's Encrypt that it renews itself.
- **`tunnel`**: a Cloudflare Tunnel. The server opens no ports, and Cloudflare (free plan) serves
  HTTPS, caches the static files, applies a rate limit and absorbs traffic spikes. Worth it before a
  big launch.

On your own machine you don't need any of this: see [SELF_HOSTING.md](SELF_HOSTING.md).

## What a public instance does differently

- **Share links and link previews point at it.** `APP_BASE_URL` is a public name, so share links
  use it. A loopback or home-network install sends its share links to abtune.com instead
  (`SHARE_BASE_URL` overrides either).
- **It counts usage.** `STATS_FILE` turns on counters: quizzes started and finished, "Answer 10
  more", shared links opened, shares, exports and hand-offs to a music app, per day. The browser sends an event name and
  nothing else, so no IDs, IP addresses, cookies or profiles are kept. The counts are public at
  `/api/stats`, and the start screen says they are kept. Because they're public, a script shouldn't
  be able to make them up: an event counts only when the request says it comes from the site's own
  pages (an `Origin` header naming the site, or `Sec-Fetch-Site: same-origin`, which browsers send
  and pages can't), and `deploy/compose.yaml` allows 30 events a minute per visitor
  (`EVENTS_PER_MINUTE`). A quiz sends a handful. A script that fakes the headers still gets 30 a
  minute per address, so the limit slows a forger down rather than stopping one.
- **It limits playlists per visitor.** One vCPU builds about two playlists a second, so a script in
  a loop could take them all. `deploy/compose.yaml` allows 20 a minute per visitor, and a visitor
  may use a whole minute's worth at once (`PLAYLISTS_PER_MINUTE` in `deploy/.env` changes it).
  Past that, `/api/playlist` answers 429 with `Retry-After`, and the page says so and asks again by
  itself. The visitor is the address Caddy or the tunnel puts last in `X-Forwarded-For`
  (`TRUST_PROXY`), and an IPv6 address counts by its /64. Nothing is stored: the counts live in
  memory for a minute.
- **AI and Spotify stay off.** AI needs a model server next to the app. Spotify's development mode
  only works for accounts the app's owner adds by hand, so the "Save to Spotify" button is hidden.
  Visitors use "Add to your music app" instead (TuneMyMusic's song-list import, for Spotify, Apple
  Music and YouTube Music), and exports work as usual.

## 1. The server

Any Linux server with 4 GB of RAM and Docker will do (2 GB with the 50k dev sample). Measured on
abtune.com's server (Hostinger KVM 1: 1 vCPU, 4 GB, Ubuntu 26.04) with the full catalog: the app
holds about 1.3 GB, loads the catalog in 13 s, and makes a 50-song playlist in 0.5 s (p95 0.7 s).

1. Create the server with Ubuntu (24.04 or 26.04) and sign in with an SSH key.
2. Install Docker: `curl -fsSL https://get.docker.com | sh` (or pick a "with Docker" template).
3. Firewall: `ufw allow OpenSSH`, plus `ufw allow 80/tcp && ufw allow 443/tcp && ufw allow 443/udp`
   for Caddy (not needed for the tunnel), then `ufw enable`.
4. Automatic security updates: `apt install unattended-upgrades`.

## 2a. The way in: Caddy

At the domain's DNS (the registrar's panel), replace any parking records with:

| Type | Name | Points to |
|---|---|---|
| A | `@` | the server's IPv4 address |
| CNAME | `www` | the domain |

Leave out `AAAA` records unless the server answers on IPv6. In `deploy/.env`, set
`COMPOSE_PROFILES=caddy` and `SITE_HOST` to the domain. Caddy gets the certificates on its first
start, once the DNS records are visible (usually minutes), and `www` redirects to the domain.

There is no rate limit in this setup: the app keeps no per-visitor state, and a person taking the
quiz makes a handful of API calls a minute. Move to the tunnel for that.

## 2b. The way in: Cloudflare Tunnel

1. Add the domain to a free Cloudflare account and switch its nameservers at the registrar to the
   two Cloudflare gives you. It's active once Cloudflare says so (minutes to hours).
2. **SSL/TLS** → Overview: **Full**. **SSL/TLS → Edge Certificates**: turn on **Always Use HTTPS**.
3. **Zero Trust → Networks → Tunnels → Create a tunnel** → Cloudflared, named e.g. `abtune`. From the
   install command it shows, copy the token (the long string after `--token`) into `TUNNEL_TOKEN`.
4. In the tunnel, add a **public hostname**: the domain (no subdomain), service type **HTTP**, URL
   **`app:8787`**. Add `www` the same way.
5. **Rules → Redirect Rules** → template **Redirect from WWW to root** (the app answers to one name).
6. **Security → WAF → Rate limiting rules** → create one:
   - If incoming requests match: URI Path starts with `/api/`
   - With the same characteristics: IP
   - When rate exceeds: 60 requests per 10 seconds
   - Then: Block, for 10 seconds
7. In `deploy/.env`, set `COMPOSE_PROFILES=tunnel`. Close ports 80 and 443 in the firewall.

## 3. The app

On the server:

```sh
git clone https://github.com/mrdushidush/abtune.git && cd abtune/deploy
cp .env.example .env    # APP_BASE_URL, COMPOSE_PROFILES, and SITE_HOST or TUNNEL_TOKEN
chmod 600 .env
mkdir -p catalog
```

Put a catalog in `deploy/catalog/`, one folder per catalog version. The newest full build wins over a
dev sample.

- **The full catalog** (~2M songs, 275 MB): copy it from the machine that built it
  ([SELF_HOSTING.md](SELF_HOSTING.md#building-the-full-catalog-2m-tracks)):

  ```sh
  scp -r data/catalog/catalog-2026.09.2 you@server:abtune/deploy/catalog/
  ```

- **The dev sample** (50k songs, 8 MB), straight from the release:

  ```sh
  cd catalog
  curl -LO https://github.com/mrdushidush/abtune/releases/download/catalog-2026.09.2/catalog-2026.09.2-dev50k.tar
  curl -LO https://github.com/mrdushidush/abtune/releases/download/catalog-2026.09.2/catalog-2026.09.2-dev50k.tar.sha256
  sha256sum -c catalog-2026.09.2-dev50k.tar.sha256 && tar -xf catalog-2026.09.2-dev50k.tar && rm catalog-2026.09.2-dev50k.tar*
  cd ..
  ```

Then start it:

```sh
docker compose up -d --build
docker compose logs -f app    # wait for "Catalog … ready"
```

The build takes a few minutes on a small server. To skip it, set `ABTUNE_IMAGE` in `.env` to a
published image (`ghcr.io/mrdushidush/abtune:main`, built on every push to main, or `:latest`
for the newest release) and run
`docker compose pull && docker compose up -d` instead. Caddy or the tunnel starts once the app is
healthy.

## 4. Check it

- Open the site, take the quiz, and open the share link in a private window.
- Paste the site's address into a chat app: the preview shows the ABTune card.
- `curl -I http://abtune.com/` redirects to https, and `curl -I https://www.abtune.com/` to the
  domain.
- `curl https://abtune.com/api/stats` shows the counts.
- `curl -m 5 http://SERVER_IP:8787/` from elsewhere fails to connect: the app is only reachable
  through Caddy or the tunnel.

## Updating

```sh
cd abtune && git pull && cd deploy && docker compose up -d --build
# or, with ABTUNE_IMAGE set:
docker compose pull && docker compose up -d
```

The counters live in the `stats` volume and survive updates; certificates live in `caddy_data`. To
keep a copy of the counters:

```sh
docker compose cp app:/app/data/stats/stats.json ./stats-$(date +%F).json
```

A new catalog: copy the new folder into `deploy/catalog/`, then `docker compose restart app`. Remove
the old folder after a few weeks: share links made on it still open, with a note that some songs may
differ.

## Capacity

One Node process generates playlists, about two 50-song playlists a second on one vCPU with the
full catalog (the dev sample is far faster). A person finishing the quiz needs one, plus one per
reshuffle, tweak or "+25", so a small server handles a steady stream of visitors. For a launch spike,
move to a bigger plan (2+ vCPUs) for the day, and put the site behind the tunnel.
