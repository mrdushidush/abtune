# ABTune

**A/B test your taste.** Answer a fast run of this-or-that questions (*Bon Jovi or Britney? 80s or 90s? Cats or dogs?*) and get a playlist that sounds like you, built from an open catalog of ~2M songs. Push it to Spotify or export it, and share your music-personality card.

> **Status: pre-alpha.** Done: M0 (scaffold, CI, question-bank lint), M1 (the open-data music catalog), M2 (the deterministic quiz engine) and M3 (the playlist generator and persona eval). Next: M4, the web UI. The build brief is [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Run it

You need Docker (Docker Desktop on Windows/macOS).

```sh
docker compose run --rm catalog   # one time: download and verify the 50k-track dev catalog
docker compose up --build
```

Open <http://127.0.0.1:8787>. Use `127.0.0.1`, not `localhost`: Spotify only accepts loopback-IP redirect URIs.

While the repository is private, the dev catalog's download URL isn't public yet. Fetch the release asset with `gh release download catalog-2026.09 -R mrdushidush/abtune`, put the `.tar` in `data/catalog/`, and run `docker compose run --rm catalog --file data/catalog/catalog-2026.09-dev50k.tar`.

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

Web app in dev mode: `pnpm --filter @abtune/web dev:server` and `pnpm --filter @abtune/web dev:client` in two terminals, then open the Vite URL.

Node runs the TypeScript sources directly (type stripping), so there is no build step for the server or CLI. Use erasable TypeScript only (no `enum`, no `namespace`) and `.ts` import extensions.

## Layout

| Path | What |
|---|---|
| `packages/engine` | Pure, deterministic core: profile math, question selection, seeds, playlist generation, archetypes. The quiz runs in the browser; generation runs on the server. |
| `packages/bank` | Question bank YAML: schema, parsing, merging, lint. |
| `packages/catalog` | Catalog pipeline (DuckDB): downloads, extraction, canonicalization, features, dev sample, fixture. |
| `packages/eval` | Persona eval harness: persona bot, playlist metrics, weight tuning, reports. |
| `packages/cli` | The `abtune` command. |
| `apps/web` | API server (Hono) and UI (React + Vite). |
| `data/questions` | `seed.yaml` and community packs. |
| `data/personas` | The 12 eval personas (what a listener wants, in the bank's dimensions). |
| `data/tag_map.yaml` | MusicBrainz tags → genre clusters, community-editable like the question packs. |
| `data/catalog-fixture` | 5k-track test catalog (CC BY-NC-SA 3.0 US). |
| `docs` | Brief, ADRs, decision log, data licenses, catalog reports, eval reports. |

## Add questions

Question packs are plain YAML, no code needed. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Code: [MIT](LICENSE). The music catalog (full build, dev sample and `data/catalog-fixture/`) is **CC BY-NC-SA 3.0 US**, because its genre data comes from MusicBrainz tags. Every source is listed in [docs/DATA_LICENSES.md](docs/DATA_LICENSES.md).
