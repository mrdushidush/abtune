# Self-hosting ABTune

> This covers the music catalog (M1), the web app (M4), Spotify (M5) and the optional AI layer (M7). The full walkthrough (M9) comes later.

## Quick start: Docker and the dev catalog

```sh
docker compose run --rm catalog   # download, verify and install the 50k-track dev catalog
docker compose up --build         # http://127.0.0.1:8787
```

`/api/health` should report the catalog:

```json
{ "catalog": { "version": "catalog-2026.09.2", "kind": "dev-sample", "tracks": 50000, "status": "ready" } }
```

The `catalog` service runs `abtune catalog fetch`. It downloads one ~8 MB archive, checks its sha256 and every file's sha256 in the manifest, and unpacks it into `./data/catalog/`. The download URL defaults to the GitHub release; set `CATALOG_SAMPLE_URL` in `.env` to use a mirror. To install an archive you already have, put it in `data/catalog/` and run `docker compose run --rm catalog --file data/catalog/catalog-2026.09.2-dev50k.tar`.

Without Docker, use `pnpm abtune catalog fetch` (or `--file <tar>`).

**Which catalog the app uses:** `CATALOG_PATH` if set. Otherwise the best catalog under `data/catalog/`: a full build beats the dev sample, and a newer version beats an older one.

## The web app

The server starts listening at once and loads the catalog's columns in the background. Until it's done, `/api/health` reports `"status": "loading"` and the result screen says "Warming up the music catalog…" and retries on its own. Measured on the machine below (2026-10-02):

| catalog | load | memory | `POST /api/playlist`, 50 tracks |
|---|---:|---:|---|
| dev sample (50k) | 0.4 s | small | instant |
| full (2M) | 7.7 s | ~230 MB of columns | p50 257 ms, p95 522 ms (generation plus track lookup) |

The server answers only to loopback names (`127.0.0.1`, `localhost`), IP addresses and the host names in `APP_BASE_URL` and `SPOTIFY_REDIRECT_URI`; any other `Host` gets 403 `unknown_host`, which stops DNS-rebinding pages. Behind a reverse proxy, set `APP_BASE_URL` to your public URL. Model calls (AI layer) run one at a time with up to 4 waiting; more get the classic playlist with a "busy" notice.

The quiz runs entirely in the browser. The server receives only the quantized taste profile, the seed and the playlist length, never the answers, and it logs no request bodies. Sessions and 👍/👎 feedback stay in the browser's local storage.

## Saving playlists to Spotify

Export (M3U, CSV, XSPF, JSON) always works without an account. To save playlists straight into Spotify, each ABTune install uses **its own Spotify app**: Spotify's Development Mode allows 5 users per app, and the account that owns the app needs **Spotify Premium**. The "Save to Spotify" button walks you through this; the same steps:

1. Open the [Spotify developer dashboard](https://developer.spotify.com/dashboard) and create an app. Its name must not start with "Spot" (Spotify's rules). Tick **Web API**.
2. Add the redirect URI **exactly**: `http://127.0.0.1:8787/callback`. Spotify doesn't accept `localhost`; use the loopback IP, with your port if you changed `ABTUNE_PORT`. Behind a reverse proxy, use your `https://…/callback` instead and set `SPOTIFY_REDIRECT_URI` to it.
3. Under **User Management**, add the Spotify accounts that will use it (up to 4 besides you).
4. Put the app's Client ID and a token key in `.env`:

   ```sh
   SPOTIFY_CLIENT_ID=<the app's Client ID>
   TOKEN_ENCRYPTION_KEY=<32+ random characters>   # node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
   ```

5. Restart: `docker compose up -d` (or restart `pnpm --filter @abtune/web start`). The server log says `Spotify: redirect http://127.0.0.1:8787/callback` when it's set up, or lists what's missing.
6. Open the app **at `http://127.0.0.1:8787`** (the redirect URI's address), press **Save to Spotify**, then **Connect Spotify**. After Spotify's consent screen you come back to your playlist and can save it.

**What happens on save:** each song is looked up by ISRC, then by title and artist. Songs Spotify doesn't have are replaced by similar ones (same genre and decade, a new artist), so you get the full length; the sheet lists the swaps. Playlists are private unless you tick "Show it on my Spotify profile". A 50-song save takes about 50–80 Spotify requests.

**What's stored:** the refresh token, encrypted with `TOKEN_ENCRYPTION_KEY`, in `data/spotify/tokens.json`. The browser keeps only an HttpOnly cookie that names its connection, and never sees a token. Nothing about Spotify's tracks is written to disk (matches are cached in memory for an hour). **Disconnect** deletes the connection; to revoke ABTune's access on Spotify's side too, visit [spotify.com/account/apps](https://www.spotify.com/account/apps/). If you change `TOKEN_ENCRYPTION_KEY`, stored connections can't be opened anymore: just connect again.

**From Claude Code:** the MCP server's `push_to_spotify` uses the connection made in the web app (it reads the same `.env` and `data/spotify/`), so connect once in the browser first.

| Problem | Fix |
|---|---|
| "Spotify won't let this account use the app" / 403 | Add the account under User Management in the dashboard; check that the app owner's Premium is active |
| `INVALID_CLIENT: Invalid redirect URI` on Spotify's page | The redirect URI in the dashboard and `SPOTIFY_REDIRECT_URI` must match character for character |
| "This Spotify app has used up its request quota" | Spotify's per-developer quota; wait, or export the CSV meanwhile |
| Connect sends you to `127.0.0.1` and your quiz is gone | Your session is saved per address. Use `http://127.0.0.1:8787` from the start; the sheet offers a link that reopens the playlist there |
| Linux: sign-in fails with a permission error in the log | `data/spotify` must be writable by the container's `node` user (uid 1000): `sudo chown 1000:1000 data/spotify` |

## The AI layer (optional)

ABTune works fully without AI. With a **local** model server, the quiz can offer "AI touches":

- The model reads your answers together and fine-tunes the profile, with a playlist title and a line about it.
- You can describe what the playlist is for in your own words ("rainy Sunday", "a 5k run").
- If you turn on rerank, the model also picks the songs from a shortlist and says why for each.

The engine keeps every result within bounds, and the model can only choose songs from the catalog. When the model is slow, down or makes no sense, you get the classic playlist and a one-line notice. v0.1 supports OpenAI-compatible local servers only: LM Studio, Ollama, llama.cpp server, vLLM.

**What the model sees:**
- Your answers as text ("chose Bon Jovi over Britney Spears") and your taste profile.
- Never the answers to sensitive questions (the political ones in the Spicy pack), unless the server allows it (`ALLOW_SENSITIVE_TO_AI=true`) **and** you tick the opt-in for that quiz.
- For rerank, the shortlist's titles and artists.

Nothing is stored: model answers are cached in memory only, and the server logs only failures, by kind ("timeout"). Share links carry the results (the adjusted profile, the picked songs, the title) and rebuild the playlist without calling the model.

**Setup with LM Studio** (Developer tab → load a model → Start Server):

```sh
# .env
AI_PROVIDER=openai_compat
AI_BASE_URL=http://host.docker.internal:1234/v1   # without Docker: http://127.0.0.1:1234/v1
AI_MODEL=qwen3.6-35b-a3b-mtp@iq3_s                 # the id your server lists at <AI_BASE_URL>/models
AI_REASONING_EFFORT=none                           # thinking models (Qwen 3): answer without thinking
# RERANK_BACKEND=llm                               # optional: the model picks the songs too (slower)
```

Then `docker compose up -d`. The server log ends with `AI: <model> at <url>`, and the setup screen shows the "AI touches" switch. Check the connection with `pnpm abtune ai check`, which lists the server's models and times one call of each kind.

- **Ollama:** `AI_BASE_URL=http://host.docker.internal:11434/v1`, model ids like `qwen3:30b-a3b`.
- **llama.cpp server:** port 8080, e.g. `llama-server -m <model.gguf> --port 8080`.
- **Docker on Linux:** `host.docker.internal` points to the Docker bridge, so the model server must listen on that interface or `0.0.0.0` (in LM Studio, "Serve on Local Network"). Docker Desktop on Windows and macOS also reaches a server on the host's 127.0.0.1.

**Speed** (measured 2026-10-03: Qwen 3.6 35B-A3B, IQ3_S, in LM Studio on an RTX 5060 Ti 16 GB, ~58 tokens/s):

| call | time | limit |
|---|---:|---:|
| reading your answers (T1) | 2–4 s | 20 s |
| a free-text tweak (T3) | ~3 s | 20 s |
| rerank, 25 songs | ~12 s | 20 s |
| rerank, 50 songs | ~25 s | 40 s |
| rerank, 100 songs | ~50 s (estimated) | 80 s |

`AI_TIMEOUT_MS` sets the limit per call (default 20000). Rerank gets that limit per 25 songs. A smaller or slower model may need a longer limit, or rerank off.

**Measuring a model:** `pnpm abtune ai eval` runs the persona eval with and without the model's adjustments. `pnpm abtune ai enrich --eval 300` checks how well it rates songs' sound against AcousticBrainz. Both pause while an NVIDIA GPU is at 65 °C or hotter (`--max-gpu-temp`). Results for the model above are in `docs/eval/2026-10-03-ai-*.md`.

| Problem | Fix |
|---|---|
| No "AI touches" switch | The server log says why (`AI: AI_MODEL is required…`); `/api/health` shows `ai.enabled` |
| "The AI server didn't answer" | Is the model server running and the model loaded? From Docker, use `host.docker.internal`, not `127.0.0.1` |
| "The AI took too long" | Raise `AI_TIMEOUT_MS`, use a smaller model, or turn rerank off |
| "The AI's answer didn't make sense" | The model ignored the JSON schema: use a server that supports `response_format: json_schema` (structured output), and set `AI_REASONING_EFFORT=none` for thinking models. Only LM Studio was tested |

## Building the full catalog (~2M tracks)

You only need this for the full catalog, or to rebuild from newer dumps. Everything runs locally; nothing is uploaded.

```sh
pnpm abtune catalog download   # ~72 GB of dumps into data/dumps/, resumable and sha256-checked
pnpm abtune catalog build      # extract → load → songs → candidates → popularity → select → features → export
pnpm abtune catalog sample     # optional: the 50k dev sample + 5k fixture from your build
```

The build writes `data/catalog/catalog-YYYY.MM/` (tracks.parquet, manifest.json, LICENSE.md) and `docs/catalog-report-YYYY.MM.md`. Every step resumes: rerunning skips finished steps whose inputs are unchanged, and `--from-stage <stage>` reruns one stage and everything after it. `--no-api` skips the ListenBrainz popularity API and ranks by the dump-derived proxy alone.

### Requirements (measured on Windows 11, 12 threads, 32 GB RAM, NVMe SSD, 2026-10-02)

| | |
|---|---|
| Software | Node 24 and pnpm 10. A system `tar` that can read bz2: built into Windows 10+ (`C:\Windows\System32\tar.exe`); on Linux, GNU tar with `bzip2`, or better `lbzip2`, which is used automatically and is several times faster |
| Download | 75.3 GB (35 files). 13 min at ~100 MB/s |
| Disk | Dumps 71 GiB, extracted tables 29 GiB (`data/build/raw/`), DuckDB working files 31 GiB (`data/build/<version>/`), catalog 0.3 GiB. Plan for **~160 GB free** |
| RAM | DuckDB uses up to half of RAM by default and spills to disk beyond that. On a 32 GB machine with a browser open that was too much: pass `--memory 10GB` |
| Network during the build | ~3,900 calls to the ListenBrainz popularity API: serial and rate-limit-aware, ~25 min at ~2.9 calls/s. Cached under `data/dumps/lb-popularity-api/`, so rebuilds only fetch new MBIDs |

### Time per step

| step | time | notes |
|---|---:|---|
| download | 13 min | network-bound |
| extract MusicBrainz | ~40 min | single-threaded bz2 on Windows; lbzip2 on Linux is much faster |
| extract AcousticBrainz | 9.5 min | 29.5M JSON documents across 10 worker threads, streamed (never unpacked to disk) |
| extract ListenBrainz statistics | 9 min | 84,850 users' top lists, 39M rows |
| extract canonical | 35 s | |
| load | 1.5 min | 40.4M recordings, 39M top-list rows, 29.3M AcousticBrainz submissions into DuckDB |
| songs | 3–4.5 min | canonical redirects, dedupe, Hebrew pool seeding: 4.8M songs |
| candidates | 2–4 min | 3.64M candidates, genres, non-music filter |
| popularity | 23 min first time | 3,912 API calls. With a warm cache: 30 s |
| select | 20 s | top 2M plus the Hebrew quotas |
| features | 50 s | ridge regression on 1.39M tracks |
| hits | 70 s | the hits view: each artist's best-known songs (proxy listeners, Various-Artists compilations), Israeli artists from `data/il_artists.yaml` |
| export | 2 min | tracks.parquet (262 MiB), digest, report |
| **build after extraction** | **~35 min** | ~15 min with a warm API cache (catalog-2026.09.2: 14.5 min). From scratch, download included: ~2 h |
| sample | 10 s | 50k dev sample (8 MB .tar, mostly hits) and 5k fixture |

The Israeli hits come from a curated list, `data/il_artists.yaml` (artist, tier, up to 3 signature songs), because the popularity data barely sees Israeli listeners. `abtune catalog il-draft` drafts it from a built catalog; after editing it, `abtune catalog build --from-stage hits` re-runs only the last two stages (~3 min).

## Licenses

The catalog is **CC BY-NC-SA 3.0 US** because of MusicBrainz tags; the code is MIT. See [DATA_LICENSES.md](DATA_LICENSES.md).
