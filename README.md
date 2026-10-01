# ABTune

**A/B test your taste.** Answer a fast run of this-or-that questions (*Bon Jovi or Britney? 80s or 90s? Cats or dogs?*) and get a playlist that sounds like you, built from an open catalog of ~2M songs. Push it to Spotify or export it, and share your music-personality card.

> **Status: pre-alpha.** Milestone M0 (scaffold) is done; the quiz engine (M2) is in progress. The build brief is [`docs/HANDOFF.md`](docs/HANDOFF.md).

## Run it

You need Docker (Docker Desktop on Windows/macOS).

```sh
docker compose up --build
```

Open <http://127.0.0.1:8787>. Use `127.0.0.1`, not `localhost`: Spotify only accepts loopback-IP redirect URIs.

## Develop

Node 24+ and pnpm 10 (`npm i -g pnpm`).

```sh
pnpm install
pnpm test          # all tests
pnpm typecheck
pnpm lint          # Biome
pnpm abtune lint   # validate the question bank
```

Web app in dev mode: `pnpm --filter @abtune/web dev:server` and `pnpm --filter @abtune/web dev:client` in two terminals, then open the Vite URL.

Node runs the TypeScript sources directly (type stripping), so there is no build step for the server or CLI. Use erasable TypeScript only (no `enum`, no `namespace`) and `.ts` import extensions.

## Layout

| Path | What |
|---|---|
| `packages/engine` | Pure, deterministic core: profile math, question selection, seeds. Runs in the browser and on the server. |
| `packages/bank` | Question bank YAML: schema, parsing, merging, lint. |
| `packages/cli` | The `abtune` command. |
| `apps/web` | API server (Hono) and UI (React + Vite). |
| `data/questions` | `seed.yaml` and community packs. |
| `docs` | Brief, ADRs, decision log. |

## Add questions

Question packs are plain YAML, no code needed. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

Code: [MIT](LICENSE). The music catalog is built from open data with its own licenses, documented in `docs/DATA_LICENSES.md` once the catalog pipeline lands (M1).
