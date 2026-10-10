# Changelog

All notable changes to ABTune. The format follows [Keep a Changelog](https://keepachangelog.com/),
and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added
- A limit on playlists per visitor for public instances (`PLAYLISTS_PER_MINUTE`, with
  `TRUST_PROXY` behind a reverse proxy). The public deploy kit allows 20 a minute. Past it, the page
  says so and asks again by itself.
- Add ABTune to your phone's home screen: it opens full screen, like an app, with its own icon
  ("Add to Home Screen" on iPhone, "Install app" on Android).
- Every MCP tool says whether it only reads, can replace a file, is safe to repeat, and reaches
  outside the server (the four MCP tool hints), so hosts can tell which calls are safe to run
  unasked. Only `push_to_spotify` reaches outside; only `export_playlist` can replace a file.

### Changed
- Playlists fit short quizzes much better. In 200 test runs in a browser, the share of playlists
  that fit the listener rose from 42% to 64%, and clear misses fell from 42% to 28%:
  - Eras follow your answers more closely: a 2010s fan no longer gets 1950s songs after 10 cards,
    and liking the 80s also brings in the late 70s and early 90s.
  - Cards that settle a tie between your two leading genres ("Your playlist needs more: rap verses
    or pop choruses?") now come from the sixth card on instead of the 21st, with 21 new ones across
    rap, pop, dance, rock, country, jazz, K-pop and more.
  - With the Israeli pack on, "Hebrew songs in your mix?" is the second card, and for "Lots of
    Hebrew" the third is "Shlomo Artzi or Eyal Golan?".
- On a phone, Export, Share and Reshuffle sit in one row of three without their labels wrapping, and
  the export menu opens across the whole row.
- Button icons are drawn instead of using arrow characters, which some phones showed as emoji.
- The Dockerfile is now `deploy/Dockerfile`. `docker compose` finds it; with plain `docker build`,
  pass `-f deploy/Dockerfile`. The contributing guide, code of conduct and security policy moved to
  `.github/`, and this changelog to `docs/`.

### Security
- A plain script can no longer add to a public instance's usage counts. `/api/event` counts only
  requests that say they come from the site's own pages (an `Origin` header naming the site, or a
  browser's `Sec-Fetch-Site: same-origin`), and at most `EVENTS_PER_MINUTE` a minute per visitor
  (30 in the public deploy kit). A quiz sends a handful, so visitors never notice.

## [0.1.0] - 2026-10-07

The first public release, in beta. Try it at [abtune.com](https://abtune.com).

### The quiz
- This-or-that cards in four depths (10, 20, 50 or 100 questions): tap, swipe, or use the arrow keys.
  Both and Skip, Back, and "Answer 10 more" at the end.
- 336 questions in six packs: Core, Moments, Deep cuts (unlocked by your answers, including genre
  duels), Vibe, Spicy (opt-in) and an Israeli pack (on by default in Israel).
- A live hint chip shows what your answers say so far, and every session asks a different mix.

### The playlist
- Built from an open catalog of ~2M songs (MusicBrainz, ListenBrainz, AcousticBrainz), leaning on
  songs people know: each artist's best-known songs first.
- Reshuffle, tweak (energy, mood, popularity, era), "+25 deeper cuts", swap a song, play any song on
  YouTube or Spotify.
- "Add to your music app": Spotify, Apple Music or YouTube Music, through TuneMyMusic's free song-list
  import. ABTune copies the list; you paste it there and sign in to your app there.
- Export as M3U, CSV, XSPF or JSON, or save it to Spotify directly with your own Spotify app
  (self-hosted).
- Holiday songs (Christmas, Hanukkah and the like) stay out of playlists.

### Sharing
- A music-personality card: archetype, sound profile, top genres and era.
- Share links rebuild the card and the exact playlist on any device. A self-hosted install's links
  open on abtune.com.
- The card as an image, as a 4:5 post or a 9:16 story.

### Privacy
- No login. Answers stay in the browser; the server only gets the taste profile and keeps no record
  of it. A public instance counts events per day (no IDs) and says so.

### For developers and self-hosters
- `docker compose up` with the 50k dev catalog, or build the full catalog from the open dumps.
- An MCP server: Claude Code (or any MCP host) takes the quiz from a description and makes the
  playlist.
- Optional AI touches with a local model (LM Studio, Ollama, llama.cpp): reads your answers, "Describe
  it" tweaks, and picks from a shortlist.
- A persona eval that measures how well playlists fit 12 listener types.
- A deploy kit for a public instance: Docker Compose with Caddy (automatic HTTPS) or a Cloudflare
  Tunnel.
- Docker images on GitHub's registry (amd64, arm64).

[Unreleased]: https://github.com/mrdushidush/abtune/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mrdushidush/abtune/releases/tag/v0.1.0
