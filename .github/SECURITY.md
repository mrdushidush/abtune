# Security

## Reporting a vulnerability

Please report it privately through GitHub: the repository's **Security** tab → **Report a
vulnerability**. Don't open a public issue. You'll get an answer within a few days, and a fix or a
plan within two weeks for anything serious. Credit goes in the release notes if you want it.

Supported: the latest release and `main`.

## What ABTune keeps, and where

- **No accounts.** The quiz runs in the browser, and the answers stay there (local storage). The
  server gets only the resulting taste profile (a few dozen numbers) to pick songs, and doesn't
  store it or log it.
- **Share links** carry the taste profile and playlist settings in the URL fragment (`#s=…`), which
  browsers don't send to servers. Opening one sends the server the same profile as above.
- **Add to your music app** copies the song list to the clipboard and opens TuneMyMusic in a new
  tab. ABTune sends TuneMyMusic nothing; the visitor pastes the list there and signs in there.
- **Spotify** (self-hosted only): the sign-in token is stored encrypted (AES-GCM, with
  `TOKEN_ENCRYPTION_KEY`) in `data/spotify/tokens.json`, readable by the web app and the MCP server
  on that machine.
- **AI** (optional, off by default): answers go to the AI server you configure (a local one in this
  version), and sensitive answers only with a per-session opt-in.
- **A public instance** (`STATS_FILE`, as on abtune.com) counts events per day: quizzes started and
  finished, shares, exports. Only the event name is sent: no IDs, IP addresses or cookies. The counts
  are public at `/api/stats`. To keep a script from making them up, an event counts only when it
  says it comes from the site's own pages, and at most 30 a minute from one address (held in memory
  for a minute, like the playlist limit, and never written down).

## Hardening already in place

A strict Content Security Policy and the usual security headers; a Host allowlist against DNS
rebinding (loopback, IP addresses and `APP_BASE_URL`); an Origin check on every request that acts
for the browser; request size limits; the MCP server writes only inside its export folder; catalog
downloads are checked against their SHA-256 and unpacked without path traversal. The self-hosted
server listens on 127.0.0.1 only; a public instance runs behind a reverse proxy or tunnel
([docs/DEPLOY.md](../docs/DEPLOY.md)). CI actions are pinned to commit SHAs.
