# ADR-0001: Stack — TypeScript everywhere, DuckDB for the catalog

- **Status:** Accepted
- **Date:** 2026-10-01
- **Decided by:** David (@mrdushidush), ABTune's owner and maintainer
- **Proposed by:** Claude Code, the AI coding tool ABTune is built with, as the brief asked (HANDOFF §0)

## Context

ABTune has one pure engine that four surfaces share (web UI, API, CLI, MCP server), an offline ETL over 40+ GB of compressed open music data, and a scoring step over ~2M tracks that must return a 50-track playlist in under 2 s at p95. Self-hosters must get a working app from one `docker compose up` on Windows 11, macOS and Linux. HANDOFF §5.3 lists eight selection criteria; this ADR scores the choice against each.

The quiz must feel instant: no network round-trip per question (HANDOFF §4.2). The selection engine therefore has to run **in the browser** as well as on the server. That pins the engine to JavaScript/TypeScript, or to WASM compiled from another language.

## Decision

| Concern | Choice |
|---|---|
| Language | **TypeScript** throughout, strict mode, erasable syntax only |
| Runtime | **Node 24 LTS**, running `.ts` sources directly via built-in type stripping. No transpile step for the server or CLI |
| Workspace | **pnpm 10** workspaces: `apps/web`, `packages/{engine,bank,cli,…}` |
| Engine | `@abtune/engine`: pure TS, its only dependency is `@noble/hashes` (sha256). No fs, network, clock or global RNG |
| Question bank | `yaml` (YAML 1.2 core schema), `zod` v4 schema, custom lint, generated JSON Schema for editors |
| Catalog ETL and store | **DuckDB** (`@duckdb/node-api`): streaming joins and aggregation over dumps; output is a versioned **Parquet** directory plus a manifest. At startup the server loads the numeric columns into typed arrays for scoring |
| API server | **Hono** on `@hono/node-server` |
| UI | **React 19 + Vite + Tailwind v4** SPA, served by the same process |
| Share images | **Satori** (JSX → SVG) + **`@resvg/resvg-js`** (SVG → PNG) |
| MCP | Official **`@modelcontextprotocol/sdk`**, stdio transport |
| Tests / lint | Vitest + fast-check; Biome; TypeScript 7 (native) for typechecking only |
| Container | One image on `node:24-bookworm-slim` (glibc), one compose service |

## Scoring against HANDOFF §5.3

| # | Criterion | How this stack meets it | Fit |
|---|---|---|---|
| 1 | One-command self-host on Win 11 / macOS / Linux | One image, one service, no database server. Debian base works under Docker Desktop (WSL2) and on Linux; DuckDB and resvg ship glibc prebuilt binaries. Verified on Windows 11 (local) and Linux (CI) in M0 | Strong |
| 2 | Pure engine shared by web, CLI and MCP | The same TS package is imported by the browser bundle (Vite), the server, the CLI and the MCP server. No FFI or polyglot boundary | Strong |
| 3 | Stream 40+ GB compressed JSON; join tens of millions of rows on one machine | DuckDB does the columnar joins, aggregation and spill-to-disk. Node streams handle tar/zstd extraction (`node:zlib` zstd, or system `zstd`/`lbzip2` in the catalog image) and append into DuckDB | Good |
| 4 | Vectorized scoring over ~2M rows, p95 < 2 s for 50 tracks | 2M × ~60 B of typed arrays ≈ 120 MB in memory. One scoring pass is a tight loop over `Float32Array`s (tens of ms). Generation runs server-side only, in one pinned runtime, which also helps determinism | Strong |
| 5 | Official MCP SDK | `@modelcontextprotocol/sdk` is the reference SDK | Strong |
| 6 | Server-side PNG for share cards and OG images | Satori + resvg-js is the standard JS path; no headless browser | Strong |
| 7 | Contributors add packs with zero code | YAML packs plus `abtune lint` with `file:line` diagnostics plus a generated JSON Schema (autocomplete of every dimension key in VS Code). The web build fails on lint errors | Strong |
| 8 | Minimal moving parts; justify every service | One process, one container, no Postgres or Redis. The catalog is a read-only file set mounted into the container. Embedded DuckDB is chosen over SQLite because the workload is analytical and columnar, not transactional | Strong |

## Alternatives considered

- **TS runtime + Python ETL** (DuckDB/Polars, LightGBM). Better ML tooling for tier-3 feature imputation, but it doubles the toolchains (two lint/test/CI setups, a second image) for one offline step. Instead, tier-3 imputation uses hierarchical shrinkage plus ridge regression in TS, with held-out MAE reported. If that MAE is poor, an optional LightGBM script behind the same interface is the fallback, logged in DECISIONS.md.
- **Rust core compiled to WASM.** Fastest scoring, but it raises the bar for contributors and complicates the browser/server/MCP sharing. TypeScript already meets the performance target.
- **Postgres as the catalog store.** Adds a service, migrations and tuning for data that is read-only and analytical. Rejected per criterion 8.
- **A build step (tsx, tsdown) for server and CLI.** Unnecessary: Node 24 strips types natively. A bundle is still needed for npm-published packages (the MCP server in M8), because Node won't strip types under `node_modules`.

## Consequences

- Contributors need only Node 24 and pnpm. Docker is needed only to self-host or build the catalog.
- Source must stay *erasable* TypeScript (no `enum`, `namespace`, parameter properties) and use `.ts` import extensions. `tsconfig.base.json` enforces this with `erasableSyntaxOnly`.
- Determinism across machines relies on: integer-only PRNG (`Math.imul`), code-unit string comparison (never `localeCompare`), canonical JSON before hashing, and quantized scores before sorting and sampling. Generation never runs in the browser, so the server's single runtime is the reference.
- Native modules (DuckDB, resvg) pin the container to glibc. Alpine is not supported.
- **Revisit if:** p95 scoring misses 2 s on the full catalog (option: move scoring into DuckDB SQL or WASM SIMD), or tier-3 imputation MAE is unacceptable without GBMs.
