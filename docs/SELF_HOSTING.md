# Self-hosting ABTune

> This covers the music catalog (M1) and the web app (M4). Spotify setup (M5), the AI layer (M7) and the full walkthrough (M9) come later.

## Quick start: Docker and the dev catalog

```sh
docker compose run --rm catalog   # download, verify and install the 50k-track dev catalog
docker compose up --build         # http://127.0.0.1:8787
```

`/api/health` should report the catalog:

```json
{ "catalog": { "version": "catalog-2026.09", "kind": "dev-sample", "tracks": 50000, "status": "ready" } }
```

The `catalog` service runs `abtune catalog fetch`. It downloads one ~7 MB archive, checks its sha256 and every file's sha256 in the manifest, and unpacks it into `./data/catalog/`. The download URL defaults to the GitHub release; set `CATALOG_SAMPLE_URL` in `.env` to use a mirror. To install an archive you already have, put it in `data/catalog/` and run `docker compose run --rm catalog --file data/catalog/catalog-2026.09-dev50k.tar`.

Without Docker, use `pnpm abtune catalog fetch` (or `--file <tar>`).

**Which catalog the app uses:** `CATALOG_PATH` if set. Otherwise the best catalog under `data/catalog/`: a full build beats the dev sample, and a newer version beats an older one.

## The web app

The server starts listening at once and loads the catalog's columns in the background. Until it's done, `/api/health` reports `"status": "loading"` and the result screen says "Warming up the music catalog…" and retries on its own. Measured on the machine below (2026-10-02):

| catalog | load | memory | `POST /api/playlist`, 50 tracks |
|---|---:|---:|---|
| dev sample (50k) | 0.4 s | small | instant |
| full (2M) | 7.7 s | ~230 MB of columns | p50 257 ms, p95 522 ms (generation plus track lookup) |

The quiz runs entirely in the browser. The server receives only the quantized taste profile, the seed and the playlist length, never the answers, and it logs no request bodies. Sessions and 👍/👎 feedback stay in the browser's local storage.

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
