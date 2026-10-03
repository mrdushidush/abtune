# ABTune

**A/B test your taste.** Answer a fast run of this-or-that questions (*Bon Jovi or Britney? 80s or 90s? Cats or dogs?*) and get a playlist that sounds like you, built from an open catalog of ~2M songs. Push it to Spotify or export it, and share your music-personality card.

> **Status: pre-alpha.** Done: M0 (scaffold, CI, question-bank lint), M1 (the open-data music catalog), M2 (the deterministic quiz engine), M3 (the playlist generator and persona eval), M4 (the web UI: quiz, personality card, playlist, export), M5 (save to Spotify with your own Spotify app; tested against a stand-in, the check with a real app is pending), M6 (share links and the card image) and M8 (the MCP server). Next: M7, the optional AI layer. The build brief is [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Run it

You need Docker (Docker Desktop on Windows/macOS).

```sh
docker compose run --rm catalog   # one time: download and verify the 50k-track dev catalog
docker compose up --build
```

Open <http://127.0.0.1:8787>. Use `127.0.0.1`, not `localhost`: Spotify only accepts loopback-IP redirect URIs.

Pick how deep to go (10, 20, 50 or 100 questions) and a playlist length. Then tap, swipe or use the arrow keys through the cards (← → pick, ↑ both, ↓ skip, ⌫ back). You get a music-personality card and a playlist of songs people actually know (each artist's best-known songs, unless you ask for hidden gems). You can reshuffle it, tweak it ("more energy", "newer", …), add 25 deeper cuts, swap a song, play any song on YouTube or Spotify, extend the quiz with 10 more answers, and export as M3U, CSV, XSPF or JSON. **Share** gives a link that rebuilds your card and the exact playlist on any device, and saves the card as an image. Every session asks a different mix of cards. The quiz runs in your browser, and your answers never leave it: the server and share links only carry the resulting taste profile.

While the repository is private, the dev catalog's download URL isn't public yet. Fetch the release asset with `gh release download catalog-2026.09 -R mrdushidush/abtune`, put the `.tar` in `data/catalog/`, and run `docker compose run --rm catalog --file data/catalog/catalog-2026.09-dev50k.tar`.

## Use it from Claude Code (MCP)

ABTune ships an MCP server, so Claude Code (or any MCP host) can take the quiz for you from a plain description and hand back a playlist:

```sh
pnpm install
claude mcp add abtune -- node /path/to/abtune/packages/mcp/src/main.ts
```

Then ask, for example, *"make me a playlist for a rainy Sunday and export it as CSV"*. Claude reads the questions, answers the ones your description covers, builds the playlist from your installed catalog, and exports it or gives you a share link that opens it in the web app. Tools: `list_questions`, `start_quiz` / `answer` (play card by card), `submit_answers`, `get_profile`, `generate_playlist` (from a session, a share link or a profile; with tweaks, reshuffles and deeper cuts), `export_playlist` and `push_to_spotify` (after connecting Spotify once in the web app). It needs a catalog (`abtune catalog fetch`); `CATALOG_PATH` picks one, and `APP_BASE_URL` sets where share links point (default `http://127.0.0.1:8787`). `export_playlist` writes only inside the server's working folder (or `EXPORT_DIR`), and replaces a file only when asked. Answers stay in the MCP server's process.

## The music catalog

The catalog is built from open data: MusicBrainz (recordings, releases, ISRCs, languages, tags), ListenBrainz (popularity) and AcousticBrainz (mood, danceability and tempo features). See [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md) for both ways to get it:

- **Dev sample** (50k tracks, ~7 MB): `abtune catalog fetch`. Takes seconds.
- **Full catalog** (~2M tracks): `abtune catalog download` (~72 GB of dumps), then `abtune catalog build` (~2 h from scratch, ~10 min to rebuild).

Each build writes a data quality report, for example [docs/catalog-report-2026.09.md](docs/catalog-report-2026.09.md).

## Develop

Node 24+ and pnpm 10 (`npm i -g pnpm`).

```sh
pnpm install
pnpm test          # all tests
pnpm typecheck
pnpm lint          # Biome
pnpm abtune lint   # validate the question bank
pnpm abtune sim    # replay the quiz engine: golden sequences + random-run stats
pnpm abtune generate --persona eighties_pop --mode 50   # a playlist from an eval persona
pnpm abtune eval   # persona eval + §16 checks; writes docs/eval/<date>.md on the full catalog
pnpm abtune catalog --help
```

Web app in dev mode: `pnpm --filter @abtune/web dev:server` and `pnpm --filter @abtune/web dev:client` in two terminals, then open the Vite URL. Set `CATALOG_PATH=data/catalog/catalog-2026.09-dev50k` for the server to restart in under a second (the full catalog takes ~8 s to load).

Node runs the TypeScript sources directly (type stripping), so there is no build step for the server or CLI. Use erasable TypeScript only (no `enum`, no `namespace`) and `.ts` import extensions.

## Layout

| Path | What |
|---|---|
| `packages/engine` | Pure, deterministic core: profile math, question selection, seeds, playlist generation, archetypes. The quiz runs in the browser; generation runs on the server. |
| `packages/bank` | Question bank YAML: schema, parsing, merging, lint. |
| `packages/catalog` | Catalog pipeline (DuckDB): downloads, extraction, canonicalization, features, dev sample, fixture. |
| `packages/connectors` | Playlist destinations: file export (M3U, CSV, XSPF, JSON) and Spotify (PKCE sign-in, encrypted token store, matching, backfill). |
| `packages/eval` | Persona eval harness: persona bot, playlist metrics, weight tuning, reports. |
| `packages/cli` | The `abtune` command. |
| `packages/mcp` | The MCP server (stdio): quiz, playlists, share links and export as tools. |
| `apps/web` | API server (Hono) and UI (React + Vite). |
| `data/questions` | `seed.yaml`, `more.yaml` (variants and newer cards), `il.yaml` (the Israeli pack) and community packs. |
| `data/personas` | The 12 eval personas (what a listener wants, in the bank's dimensions). |
| `data/tag_map.yaml` | MusicBrainz tags → genre clusters, community-editable like the question packs. |
| `data/catalog-fixture` | 5k-track test catalog (CC BY-NC-SA 3.0 US). |
| `docs` | Brief, ADRs, decision log, data licenses, catalog reports, eval reports. |

## Add questions

Question packs are plain YAML, no code needed. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Code: [MIT](LICENSE). The music catalog (full build, dev sample and `data/catalog-fixture/`) is **CC BY-NC-SA 3.0 US**, because its genre data comes from MusicBrainz tags. Every source is listed in [docs/DATA_LICENSES.md](docs/DATA_LICENSES.md).
