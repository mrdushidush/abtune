# Decision log

One line per non-obvious choice: date · decision · why. Big decisions get an ADR in `docs/adr/`.

## Project

- 2026-10-01 · Product named **ABTune** ("A/B test your taste"), replacing the brief's working name "Either FM" · owner's pick after collision checks: Spotify policy bars names "confusing in sound or spelling to Spotify" (rules out "-ify" names), either.fm is taken, ABFM is the American Board of Family Medicine. `docs/HANDOFF.md` is left verbatim, so read "Either FM" there as ABTune.
- 2026-10-01 · GitHub repo `mrdushidush/abtune` is private until v0.1, then public · owner's choice.
- 2026-10-01 · Stack: all TypeScript + DuckDB, see [ADR-0001](adr/0001-stack.md).
- 2026-10-01 · Node 24 type stripping runs the server and CLI from `.ts` sources, with no tsx/tsdown build step · fewer moving parts. A bundle comes back only for npm-published packages (M8), since Node refuses to strip types under `node_modules`.
- 2026-10-01 · TypeScript 7 (native compiler) is used for typechecking only.
- 2026-10-01 · Container base `node:24-bookworm-slim` · DuckDB/resvg prebuilt binaries need glibc.
- 2026-10-01 · Compose publishes on `127.0.0.1` only · Spotify loopback redirect rule; nothing should listen on the LAN by default.
- 2026-10-01 · CI: Linux runs everything plus a compose smoke test; Windows runs tests on every push; macOS runs on `main`/manual only · private-repo macOS minutes cost 10×. Hosted Windows/macOS runners can't run Linux containers, so compose is verified on Windows 11 locally; **macOS compose check is pending a manual run**.

## Question bank

- 2026-10-01 · YAML parsed as 1.2 core schema with unique keys; lint also rejects *any* unquoted `y/n/yes/no/on/off` scalar, keys included · §8.4: YAML 1.1 parsers would silently turn them into booleans.
- 2026-10-01 · `.env.example` uses `SPICY_PACK_DEFAULT=false` instead of the brief's `off` · same rule, applied consistently.
- 2026-10-01 · Label length is counted in Unicode code points (≤ 22) · accents and emoji shouldn't cost double.
- 2026-10-01 · An option with empty `fx` is a lint error · it can't inform the profile.
- 2026-10-01 · Bank merge order: the file defining `dimensions` (the seed) first, then other files by path; a duplicate id is reported in the later file · deterministic order, and contributors see errors in their own file.
- 2026-10-01 · Seed gained a `yaml-language-server` schema modeline and an updated header comment; no question changed.

## Engine (HANDOFF §7–§8)

- 2026-10-01 · A literal reading of §7.3/§8.3 reproduces both golden sequences of §16 #12: 1-indexed positions, `w_q = pack.weight × question.weight`, missing fx key = 0, tie-break by id.
- 2026-10-01 · Pacing position `i` = answered (non-skip) count + 1 · a skip re-asks the same slot type; "12 / 20" progress counts answers.
- 2026-10-01 · A `both` answer satisfies `unlock_if.any` for both `id=a` and `id=b` · liking both should open both branches.
- 2026-10-01 · Top-3 genres for `unlock_if.top_genres`: only s_c > 0, sorted by s_c desc, ties by dimension declaration order.
- 2026-10-01 · `back` pops the last log event, including skips.
- 2026-10-01 · Id tie-breaks and all sorts compare UTF-16 code units (`<`), never `localeCompare` · locale-independent determinism.
- 2026-10-01 · Seed = first **8 bytes** (64 bits) of sha256 over canonical JSON; UI shows 4 hex chars · the brief's `[:8]` is ambiguous; 64 bits seeds the PRNG fully.
- 2026-10-01 · `engine_version` = package version + `+bank.<8 hex of bank hash>` · editing the bank changes profiles, so it must change seeds too.
- 2026-10-01 · §18's "100-question mode runs out in ~15% of sessions (worst 88)" is **not reproduced**. Reference sim, 1,000 runs, spicy off: uniform a/b → 0% early; a/b/both → 0%; a/b/both/skip → 99% early (worst 65 answers). Re-measured with the real engine in M2 (`abtune sim`).
- 2026-10-01 · §16 #6 coverage measured at 100% of 1,000 random 10-question runs (a/b and a/b/both/skip).
