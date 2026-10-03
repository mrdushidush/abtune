# Either FM — Build Brief for Claude Code

> **Working name:** Either FM ("either/or" + radio). Rename freely.
> **Owner:** David (GitHub: mrdushidush) · **License:** MIT · **Brief date:** 2026-10-01
> **Companion file:** `questions.seed.yaml` → place at `data/questions/seed.yaml`

---

## 0. How to use this brief

1. Read the whole brief before writing code. Start in plan mode.
2. **You own the stack decision.** Your first deliverable is `docs/adr/0001-stack.md`, scored against the criteria in §5.3. Then implement milestone by milestone (§15).
3. External APIs here changed several times in 2025–2026. §3 was verified on 2026-10-01; anything marked *(verify)* was not. **If current docs disagree with this brief, the docs win.** Log the discrepancy in `docs/DECISIONS.md`.
4. Keep `docs/DECISIONS.md` as a running log of non-obvious choices (one line each: date, decision, why).

---

## 1. The product in one paragraph

Building a Spotify playlist by hand is tedious, but listening to a playlist that feels like *yours* is great. Either FM asks a fast series of "this or that?" questions: *Bon Jovi or Britney? 80s or 90s? BTC or XRP? Sci-fi or romance?* It turns the answers into a taste profile and builds a playlist from an open catalog of ~2M songs. The user chooses how deep to go: **10, 20, 50 or 100 questions**. More answers means a sharper profile. The result is a shareable "music personality" card plus a playlist pushed to Spotify or exported as a file. An optional AI layer (local LLM, cloud LLM, or the Jev decision model) adds creativity, and an MCP server lets Claude Code drive the whole flow.

---

## 2. Locked decisions (from the owner)

| # | Decision | Value |
|---|----------|-------|
| 1 | Audience | **Self-host first** (open source on GitHub), hosted version later |
| 2 | Destinations v1 | **Spotify (bring-your-own Client ID) + file export** (M3U, CSV, XSPF, JSON). Apple Music in v2 |
| 3 | Question flow | **Branching state machine**, deterministic: same answers → same path → same playlist. **Amended by the owner on 2026-10-03 (D7):** each session gets a random quiz seed, so retakes vary; same seed + same answers → same path → same playlist |
| 4 | Scoring | **Hand-authored effect weights as the base**, AI as an optional creative layer |
| 5 | Question bank | YAML, community-extensible via PRs. 153-question seed provided (lint-clean) |
| 6 | Political / polarizing questions | **Opt-in "spicy" pack**. Sensitive answers are never stored server-side |
| 7 | Catalog | Open data: **MusicBrainz + AcousticBrainz + ListenBrainz**, top ~2M tracks by listeners |
| 8 | Stack | **Claude Code decides** (ADR-0001) |
| 9 | Claude Code integration | Ship an **MCP server** |
| 10 | LLM layer | Any **OpenAI-compatible endpoint** (llama.cpp server, Ollama, LM Studio, vLLM) + **OpenRouter** (cloud models and Jev). Structured JSON outputs |
| 11 | MVP | 10/20/50/100 modes, branching engine, Spotify + export, shareable personality card, optional AI, MIT |

---

## 3. Hard external constraints (verified 2026-10-01)

### 3.1 Spotify Web API — the binding constraint

- **Development Mode** (all new apps):
  - **5 users per app**, allowlisted by the app owner in the dashboard
  - **App owner must have active Premium**; the app stops working if it lapses
  - Up to 25 Client IDs per developer account; **quota is shared per developer account**
  - Quota exhaustion returns **429 with JSON `"reason": "QUOTA_EXCEEDED"`**, distinct from ordinary rate limiting (which uses `Retry-After`)
- **Extended Quota** requires a registered business, 250k MAU, key-market availability and a launched service. **Out of reach for v1.** Hence bring-your-own Client ID: each self-hoster creates their own Spotify app (owner + up to 4 friends).
- **Still available in Dev Mode:**
  - `POST /me/playlists` (create)
  - `POST /playlists/{id}/items` (add; max 100 URIs per request *(verify)*)
  - `GET /search` — **`limit` max is now 10, default 5**
  - `GET /tracks/{id}` (single fetch only)
- **Gone for new / dev-mode apps:**
  - Recommendations, audio features, audio analysis, related artists (since Nov 2024)
  - Artist top tracks, browse/new releases/categories
  - Batch `GET /tracks?ids=`
  - `POST /users/{id}/playlists` (use `/me/playlists`)
  - Track/album/artist `popularity` field
- Track `external_ids` (ISRC) was removed in Feb 2026, then **restored in March 2026**. ISRC matching works.
- **Redirect URIs:** `localhost` is not allowed. Use loopback `http://127.0.0.1:<port>/callback` (dynamic ports supported). Non-loopback URIs must be HTTPS.
- **Implication:** Spotify is only the *delivery* target. All taste data (energy, mood, era, genre, popularity) must come from our own catalog.
- Read the **Developer Terms + Developer Policy** before M5. Rule of thumb: never copy Spotify metadata into the catalog. Persist only user tokens and, if the Policy permits, a minimal ISRC→URI match cache.

### 3.2 Jev (TypeSafe AI) — optional decision backend

- A non-generative "System One" **decision model**, in early access since 2026-09-15. Proprietary and hosted only.
- **Endpoint:** `POST https://openrouter.ai/api/alpha/decisions`
  - Model `typesafe/jev-1.13` (pinned) or `~typesafe/jev-latest`
  - Also reachable via the OpenRouter TS SDK (`openrouter.alpha.decisions.create`) or the TypeSafe SDKs pointed at OpenRouter
- **Request:** `{ model, state, questions }`
  - `state` is text or a JSON object; instructions may reference its fields in backticks
  - `questions` is a map of typed questions:
    - `choice`: `criteria` = `{option: description}`
    - `score`: `criteria` = ordered array of level descriptions, **max 10 levels**
    - `noul`: yes/no, no criteria
  - **The question key is never sent to the model**, so all meaning must be in `instructions`/`criteria`
- **Response:** `answers[key]`
  - `choice`: chosen option + `probabilities` + `confidence`
  - `score`: probability-weighted `score` + `probabilities` + `confidence`
  - `noul`: probability of "yes"
- **Behavior notes:**
  - Probabilities vary slightly between identical calls, so **cache results** for determinism
  - Text input only
  - Index `probabilities` by name, not position (key order shifts)
- **Pricing (2026-09-21):** $0.042 per 1M input tokens, output free, 32k context on OpenRouter
- It's an **alpha API from a new vendor**. Isolate it behind an adapter and keep it strictly optional.

### 3.3 Open music data

- **MusicBrainz:** recordings, artists, releases, works, ISRCs, release dates, languages.
  - Core data is CC0.
  - **Tags/genres are "supplementary" data under CC BY-NC-SA** *(verify)*. This affects the license of any prebuilt catalog we redistribute (§6.9).
- **ListenBrainz publishes MusicBrainz "canonical" dumps** (canonical recording redirects/metadata). Likely the fastest path to deduplicating recordings *(verify contents)*.
- **AcousticBrainz:** frozen since 2022. Dumps remain downloadable:
  - ~30M submissions, ~7M unique recording MBIDs
  - High-level dump (~39 GB compressed): mood classifiers, danceability, voice/instrumental, acoustic/electronic, genre classifiers
  - Smaller "features" dump (~3 GB): BPM/key
  - Low-level dump is ~589 GB. **We don't need it.**
- **ListenBrainz popularity:**
  - API `POST /1/popularity/recording` returns total listens + unique listeners per recording MBID (ListenBrainz + MLHD+ data)
  - Precomputed datasets at `datasets.listenbrainz.org`: popular recordings by listen count / by listeners, **popular recordings per country** (use for Hebrew/French coverage)
  - Monthly full dumps

---

## 4. User experience

### 4.1 Flow

```
Landing → Setup (mode 10/20/50/100 · playlist length 25/50/100 · packs · AI on/off)
  → Quiz (one card, two options) → Result (personality card + playlist preview)
  → Push to Spotify | Export | Share | Tweak | Reshuffle | "Answer 10 more"
```

### 4.2 Quiz screen

- Two big tappable options with label + emoji. Swipe left/right on mobile, `←`/`→` keys on desktop.
- Secondary buttons: **Both!** and **Skip**. Skip doesn't count toward N.
- **Back** undoes the last answer. The profile is recomputed from the answer log (event-sourced).
- Progress bar ("12 / 20"). Tiny live hints after some answers ("Era locking in: 80s–90s") make it feel alive.
- Mobile-first. Must feel instant (no network round-trip per question; the engine can run client-side).

### 4.3 Result screen

- **Personality card:**
  - Archetype name (§9.6)
  - Radar of the 9 scalar dims
  - Top 3 genres with %, decade bar
  - "Built from 50 answers"
  - **Never shows raw answers**
- **Playlist preview:** title, artist, year, optional cover via Cover Art Archive hotlink (not stored). Each row has a "why" chip when AI rerank is on.
- **Actions:**
  - Push to Spotify (private by default)
  - Export (M3U/CSV/XSPF/JSON)
  - Share link + PNG card
  - **Tweak** ("more energy", or a free-text box when AI is on)
  - **Reshuffle** (new seed, same profile)
  - **Answer 10 more** (continue the same session at a higher mode)
- **Feedback:** "Is this playlist *you*?" 👍/👎, stored locally only. An opt-in export of feedback helps tune weights.

### 4.4 Share links

The share payload is the **quantized final profile + seed + playlist length + catalog version**, base64url in the URL. It contains no raw answers. Opening it reproduces the card and the exact playlist without the AI layer (§9.5).

---

## 5. Architecture

### 5.1 Components

```
                ┌───────────────────── data/questions/*.yaml
                ▼
┌────────────────────────┐   pure, deterministic, no IO
│ engine                 │   profile math · next-question selection · pacing
│  (library)             │   playlist generation · archetypes · share codec
└───────┬────────────────┘
        │ used by
 ┌──────┼───────────────┬────────────────┐
 ▼      ▼               ▼                ▼
web app  CLI            MCP server       eval harness
 │       (quiz, lint,   (stdio)          (personas)
 │        catalog, eval)
 ▼
API server ── catalog store (2M tracks) ◄── catalog pipeline (offline ETL)
   │
   ├── connectors: spotify · export
   └── ai: providers (openai_compat · openrouter · anthropic) · jev adapter · cache
```

### 5.2 Boundaries

- **`engine`:** no network, no filesystem, no clock, no global RNG. Inputs in, outputs out. All randomness from an explicit seed. Every other surface (web, CLI, MCP, tests) calls it. It is also the unit-test hotspot.
- **Catalog access:** behind an interface (`CatalogReader`), so tests can use the 5k-track fixture.
- **AI:** never on the critical path. Every AI call has a deterministic fallback.
- **Connectors:** isolated modules with typed errors (§11).

### 5.3 Stack selection criteria (write ADR-0001 against these)

1. **One-command self-host:** `docker compose up` on **Windows 11 (Docker Desktop/WSL2)**, macOS and Linux.
2. A pure engine library shared by web, CLI and MCP. A polyglot setup is fine if the boundary is clean.
3. Catalog ETL must stream 40+ GB of compressed JSON and join tens of millions of rows on a single machine. Columnar/streaming tooling is expected.
4. Vectorized scoring over ~2M rows: **p95 < 2 s** for a 50-track playlist without AI (§16).
5. An official MCP SDK in the chosen language.
6. Server-side PNG rendering for share cards / OG images.
7. Contributors can add question packs with zero code (YAML + `lint`).
8. Minimal moving parts for self-hosters. Justify every extra service (e.g. Postgres vs. an embedded DB like SQLite/DuckDB).

### 5.4 Suggested repo layout (adapt to your stack)

```
/apps/web            UI + API
/packages/engine     pure core
/packages/catalog    pipeline + reader
/packages/connectors spotify, export
/packages/ai         providers, jev, cache, prompts
/packages/mcp        MCP server
/data/questions      seed.yaml + community packs
/data/personas       eval personas
/docs                adr/, DECISIONS.md, SELF_HOSTING.md, QUESTION_AUTHORING.md
```

---

## 6. Catalog pipeline (offline ETL)

### 6.1 Output

A versioned catalog, e.g. `catalog-2026.10`, with ~2M canonical recordings. Every row has features, popularity, genres, decade and language. Also produce:

- A **dev sample**: 50k tracks, downloadable
- A **test fixture**: 5k tracks, committed

Both are generated deterministically from the full build.

### 6.2 Stages

1. **Download** the MusicBrainz dump (or the ListenBrainz canonical dumps), the AcousticBrainz high-level + features dumps, and the ListenBrainz popularity datasets. Make the step resumable, with checksums.
2. **Canonicalize:** collapse duplicate recordings (remasters, compilation copies, redirects) to one canonical recording per (artist credit, normalized title). Strip `remaster|live|feat.|radio edit|mono|stereo` noise for keys, but keep live versions as separate tracks when the live version *is* the famous one (popularity decides).
3. **Popularity:** attach unique listeners + listen counts. Select the **top ~2M by unique listeners**. Also reserve quota for coverage (configurable, e.g. top N per country dataset for IL/FR/ES) so non-English music isn't drowned out.
4. **Year/decade:** earliest release date across releases containing the recording.
5. **Language:** work lyrics language, then release text language, then `unknown`.
6. **Genre clusters:** map MusicBrainz tags/genres to the 24 clusters (§7.1) with a hand-maintained `tag_map.yaml`. A track can belong to several clusters with weights. Fall back to artist-level tags.
7. **Features:** map AcousticBrainz → our scalar dims (§6.3). Impute the rest (§6.4).
8. **ISRC:** attach all ISRCs. Report coverage.
9. **Export** to the catalog store, plus a **data quality report** (§6.8).

### 6.3 Feature mapping (AcousticBrainz high-level → our dims, all scaled to [-1, 1])

| Dim | Source (AB classifier probabilities unless noted) |
|-----|---------|
| `energy` | 0.4·(1−mood_relaxed) + 0.3·mood_party + 0.3·mood_aggressive |
| `valence` | mood_happy − mood_sad |
| `dance` | danceability |
| `acoustic` | mood_acoustic − mood_electronic (organic = +) |
| `intensity` | mood_aggressive, nudged by metal/punk cluster membership |
| `tempo` | BPM from the features dump, 60→−1 … 180→+1, clamped. Correct obvious half/double-time errors using genre priors |
| `vocal` | voice_instrumental (voice = +) |
| `mainstream` | popularity percentile within the catalog (not AB) |
| `complexity` | from tags/clusters (jazz, prog, classical, experimental +; bubblegum, punk −). Not from AB |

AB classifiers are noisy. Keep a per-track `feature_confidence` and use it in scoring (§9.1).

### 6.4 Imputation tiers (record `feature_source` per track)

1. `ab_direct`: the recording MBID has AB data (or a redirect does)
2. `ab_sibling`: another recording of the same work/ISRC has AB data
3. `model`: a small regression/GBM trained on AB-labeled tracks. Inputs: tags, clusters, year, artist-level feature means. **Report held-out MAE per dim.**
4. `ai` (optional, offline): for remaining high-popularity tracks, batch-ask Jev (Score questions per dim) or a local LLM (§10, task T4)

AcousticBrainz stops at 2022, so **recent music depends on tiers 2–4**. Measure and report quality for post-2022 tracks specifically.

### 6.5 Track schema (logical)

```
track_id (canonical recording MBID), title, artist_credit, artist_mbids[], release_title,
year, decade, isrcs[], language, clusters{cluster: weight}, primary_cluster,
energy, valence, dance, acoustic, intensity, tempo, vocal, mainstream, complexity,
feature_source, feature_confidence, listeners, listens, popularity_pct, catalog_version
```

### 6.6 Dedupe and quality rules

- No two rows with the same (normalized artist, normalized title) unless both pass a popularity threshold *and* differ in version type (e.g. studio vs. iconic live).
- Drop non-music (audiobooks, spoken word, white noise, "karaoke version", "tribute to") via tag/title filters. Report how many were dropped.

### 6.7 Performance

The full build may need ~200 GB of scratch disk and hours of compute *(estimate; measure and document)*. Document the requirements in `SELF_HOSTING.md`. The **dev sample must build in < 10 minutes**.

### 6.8 Data quality report (generated each build)

- Coverage % per feature source
- Distribution per decade, cluster and language
- **Specifically IL/Hebrew and FR/French coverage**
- ISRC coverage
- Post-2022 share
- Imputation MAE

Commit the report as `docs/catalog-report-<version>.md`.

### 6.9 Licensing

- **Code:** MIT.
- **Prebuilt catalog artifact:** licensed per its most restrictive input. If it includes data derived from MusicBrainz tags (supplementary, NC-SA), the artifact is CC BY-NC-SA.
- Alternative: ship only the build script and let self-hosters build locally.
- Verify all source licenses in M1 and record them in `docs/DATA_LICENSES.md`.

---

## 7. Taste model

### 7.1 Dimensions (canonical list lives in the YAML header)

- **Scalars** (target position in [-1, 1]): `energy`, `valence`, `dance`, `acoustic`, `intensity`, `tempo`, `mainstream`, `vocal`, `complexity`
- **Decades** (categorical): `dec50` … `dec20` (≤1959 … 2020+)
- **Genre clusters** (24, categorical): `classic_rock`, `alt_indie`, `metal`, `punk`, `pop`, `dance_pop`, `hiphop`, `rnb_soul`, `funk_disco`, `house_techno`, `edm`, `chill_ambient`, `synth_newwave`, `folk`, `country`, `blues`, `jazz`, `classical`, `soundtrack`, `reggae`, `latin`, `world`, `mizrahi`, `kpop`
- **Languages** (categorical): `lang_en`, `lang_he`, `lang_fr`, `lang_es`, `lang_other`

### 7.2 Effects

Each answer option carries `fx: {key: v}` with `v ∈ [-1, 1]`.

- **Scalars:** `v` is the *target position on the axis* implied by this answer.
- **Categoricals:** `v` is additive evidence (negative = away from).

Effective weight `w = pack.weight × question.weight(default 1) × answer_mult`.

`answer_mult`:
- A/B = 1
- **Both** = 0.5, applied to the element-wise average of `fx_a` and `fx_b`
- **Skip** = no update

### 7.3 Profile update (pure fold over the answer log)

**Scalars** — prior μ = 0, C = 1 (`PRIOR_WEIGHT`, configurable):

```
μ_d ← (C_d·μ_d + w·v) / (C_d + w)
C_d ← C_d + w
```

**Categorical groups** (decades, genres, languages):

```
s_c ← s_c + w·v
E_G ← E_G + |w·v|           # group evidence
p_G = softmax(s / τ_G)      # τ tuned by the eval harness
```

- If `E_G == 0`: the group has **no preference**. Ranking ignores it and uses the catalog's natural distribution.
- Languages are a soft preference only, never a hard filter unless `p_lang` for one language ≥ 0.8.

**Amended 2026-10-03 (see DECISIONS.md):** for genres, τ grows with the evidence: τ′ = max(τ, 0.15 · s_top), where s_top is the best positive score. Scores are sums, so with a fixed τ a near-tie became 90/10 after 50 answers and could flip to 10/90 at 60. Deep profiles now keep their mix; shallow ones are unchanged.

---

## 8. Question engine (the state machine)

### 8.1 States

```
INIT → CONFIGURED(mode, length, packs, ai) → ASKING(i)
ASKING(i) --answer/skip/both--> UPDATED → SELECT_NEXT → ASKING(i+1) | PROFILE_READY
ASKING(i) --back--> ASKING(i-1)            (pop the log, refold)
PROFILE_READY → GENERATING → RESULT
RESULT --tweak/reshuffle--> GENERATING
RESULT --answer 10 more--> ASKING(i+1)     (mode += 10)
RESULT --push/export/share--> RESULT
```

Session state is only `{config, answer_log, seed_salt}`. Everything else is derived. The server can be stateless.

### 8.2 Question YAML schema (see `questions.seed.yaml`)

```yaml
- id: bonjovi_britney          # unique, snake_case, stable forever
  pack: core                   # core | context | deep | vibe | spicy | <community pack>
  pri: 95                      # 0–100 authoring priority
  q: "Bon Jovi or Britney?"    # optional; default "<a.label> or <b.label>?"
  weight: 1.0                  # optional multiplier
  sensitive: political         # optional; see §13
  unlock_if:                   # optional; eligible if ANY condition holds
    any: ["rock_pop=a"]        #   an answer in the log
    top_genres: [metal]        #   genre in current top-3 with s_c > 0
    all_top_genres: [metal, edm] # every listed genre in the top 3 (added 2026-10-03, for duels)
  a: { label: "Bon Jovi", emoji: "🎸", fx: { classic_rock: 1, dec80: 0.8 } }
  b: { label: "Britney Spears", emoji: "💃", fx: { pop: 0.8, dance_pop: 0.8 } }
```

### 8.3 Next-question selection (deterministic)

1. **Eligible** = not yet asked, pack enabled, `unlock_if` satisfied (or absent).
2. **Pacing slot** for position *i*:
   - Positions 1–3: `core` only (the hook)
   - `i % 4 == 0`: `vibe`
   - `i % 10 == 7` and spicy enabled: `spicy`
   - Otherwise: `core | context | deep`
   - If the slot's pool is empty, fall back to any eligible question.
3. **Score** each candidate:

   ```
   u(k)  = 1 / C_k              for scalar k
         = 1 / (1 + E_G(k))     for categorical k
   IG(q) = Σ_{k ∈ keys(fx_a) ∪ keys(fx_b)} |fx_a[k] − fx_b[k]| · u(k) · w_q
   score = IG(q) · (0.5 + pri/100)
   ```

4. Pick the max score. **Tie-break by `id`, lexicographic.** No randomness.

   **Amended 2026-10-03 (owner decision D7, see DECISIONS.md):** a session may carry a random quiz seed. With one, the card is a seeded draw (weighted by score) among the slot's questions scoring within a band of the best (vibe 60%, main 10%, hook and spicy 0), and a question family (`family:`, interchangeable variants) is asked once, as a seeded variant that avoids the previous session's cards. Without a seed, the rule above holds exactly, and only canonical questions are asked.

   **Amended 2026-10-03 (see DECISIONS.md):** from position 21 on, a card that splits two leading genres scores × (1 + 3 · duel value), where the duel value is c₁ · c₂ · min(|Δ₁|, |Δ₂|) for the best pair of genres the card moves in opposite directions, and c = max(0, s) / s_top. The hook never gets this bonus, and neither do positions 4–20.
5. Stop when answered (non-skip) count == mode, or the eligible pool is empty. In that case finish early with a friendly "you've exhausted the bank" message.

### 8.4 Authoring rules (enforced by `lint`)

- Unique ids; `fx` keys must exist in `dimensions`; values in [-1, 1].
- `unlock_if.any` references existing `id=a|b`; `top_genres` references valid clusters.
- **`sensitive` questions:** `fx` may only touch scalar keys, with |v| ≤ 0.4.
- **No effect may map a political, religious, ethnic, national or other identity choice to a genre or language.** Vibe questions map to *sonic feel* (energy, mood, texture, tempo), not demographic stereotypes. Reviewers enforce this; lint enforces the sensitive subset.
- Coverage: every scalar dim is touched by ≥ 5 core/context questions; every cluster by ≥ 3 questions.
- Write labels short (≤ 22 chars) so they fit mobile cards.
- Use `true`/`false`, never `on`/`off`/`yes`/`no`. YAML 1.1 parsers (e.g. PyYAML) coerce those to booleans silently.

---

## 9. Playlist generation

### 9.1 Track score

```
S_scalar(t) = Σ_d α_d·κ_d·(1 − |μ_d − f_d(t)|/2)·q(t)  /  Σ_d α_d·κ_d
   κ_d  = min(1, (C_d − 1)/K)      # confidence ramp, K ≈ 3
   q(t) = feature_confidence(t)    # 1.0 ab_direct … ~0.5 ai
G(t) = Σ_c p_c·cluster_weight_c(t) / max_c p_c
E(t) = p_decade(t) / max p_decade
L(t) = p_lang(t) / max p_lang   (1 if no language preference)

score(t) = w_s·S_scalar + w_g·G + w_e·E + w_l·L
```

Start with `w_s=.45, w_g=.30, w_e=.15, w_l=.10`. Tune with the eval harness and record the final values in DECISIONS.md.

### 9.2 Candidates and slot allocation

1. **Prefilter:** clusters covering 90% of `p_genre` mass × decades covering 90% of `p_decade` mass (or all, if a group has no preference).
2. **Cells** = (primary cluster, decade), weight `p_g·p_e`. Keep cells until cumulative weight ≥ 0.9. Allocate N slots by the largest-remainder method.
3. **Within a cell:** take the top `3×slots` by score, then pick `slots` by seeded weighted sampling (softmax over score, temperature 0.1) with MMR-style diversity on (artist, feature vector).

### 9.3 Hard constraints (100% of playlists)

- Exactly N tracks (unless the catalog is exhausted; then warn)
- Max 2 tracks per artist (1 if N ≤ 25)
- No duplicate normalized titles
- No adjacent same artist

### 9.4 Sequencing

Use a target energy curve: start mid, rise to a peak at ~65%, cool down over the last ~15%. Greedily place tracks minimizing `|energy − target(i)| + λ·|Δtempo|`, respecting the adjacency rule. Deterministic.

### 9.5 Determinism and seeds

- `seed = sha256(canonical_json(answer_log, mode, length, packs, catalog_version, engine_version, seed_salt))[:8]`
- **Reshuffle** = `seed_salt + 1`.
- `generate(profile, length, seed, catalog)` is a pure function of its inputs.
- When AI is on, AI outputs modify the profile (bounded) *before* generation and are cached by input hash. The final profile + seed is what gets shared, so share links reproduce exactly without AI.
- **The guarantee:** identical inputs give an identical ordered track list across runs, restarts and machines (same catalog version).

### 9.6 Archetypes (16) and titles

The archetype comes from four binary traits:

- Energy: Hi / Lo (μ_energy ≥ 0)
- Mood: Bright / Dark (μ_valence ≥ 0)
- Era: Retro / Modern (decade-weighted mean year < 2000)
- Texture: Organic / Electric (μ_acoustic ≥ 0)

| Energy·Mood | Retro·Organic | Retro·Electric | Modern·Organic | Modern·Electric |
|---|---|---|---|---|
| Hi·Bright | Sunburst Revivalist | Neon Nostalgist | Festival Wanderer | Dancefloor Futurist |
| Hi·Dark | Thunder Purist | Midnight Synth Rider | Riff Rebel | Bass-Drop Outlaw |
| Lo·Bright | Porch Poet | Lounge Lizard | Coffeehouse Romantic | Lo-fi Sunbather |
| Lo·Dark | Rainy-Day Balladeer | Smoky Noir Detective | Candlelit Confessor | Night-Drive Ghost |

- **Default title:** `"<Archetype> · <top cluster label> <top decade>"`. The description lists mode and seed (`"50 answers · seed 9f3a…"`).
- **AI on:** the LLM may propose a creative title/description (≤ 60 / ≤ 200 chars).

---

## 10. AI layer (optional, pluggable)

### 10.1 Providers (config-selected)

| Provider | What it provides |
|---|---|
| `openai_compat` | base URL + model + optional key. Covers llama.cpp server, Ollama, LM Studio, vLLM. Use `response_format: json_schema` (or grammar) for constrained output |
| `openrouter` | Cloud LLMs + **Jev** via the Decisions API |
| `anthropic` | Optional direct |
| `none` | Default |

**Local target:** must work well with a ~30B-class MoE quant on a 16 GB GPU through llama.cpp server. Keep prompts < 4k tokens, use schema-constrained JSON, temperature 0 and a fixed seed.

**Updated in M7 (2026-10-03, owner decision, see DECISIONS.md):** v0.1 builds `openai_compat` and `none` only (plus a test mock). `openrouter`, Jev (§10.3) and `anthropic` are not built; the layer stays pluggable for them. Rerank (T2) has its own switch (`RERANK_BACKEND=llm`), off by default. A rerank prompt with a 150-song shortlist is ~4.5k tokens.

### 10.2 Tasks

| Task | When | Output (validated, clamped) |
|---|---|---|
| **T1 Interpret** | after the quiz, before generation | `{scalar_deltas{dim:[-.3,.3]}, genre_boosts{c:[-.5,.5]}, decade_boosts{d:[-.5,.5]}, title, description}` |
| **T2 Rerank** | after slot allocation, on a ≤150-candidate shortlist | `{order:[ids ⊆ shortlist], notes{id: ≤80 chars}}` |
| **T3 Tweak** | free-text ("rainy Sunday", "for a 5k run") | same schema as T1 |
| **T4 Enrich** | offline catalog build, tier 4 | per-track scalar estimates |

### 10.3 Jev mapping (when `JEV_ENABLED=true`)

*Not built in v0.1 (owner decision 2026-10-03: local models only). Kept as the design for a later adapter.*

- **T1:** one call. `state` = JSON of answered pairs (`"chose 'Bon Jovi' over 'Britney Spears'"`) + profile summary. Questions:
  - One **Score** (5 described levels) per scalar dim
  - One **Choice** over the 24 clusters (with descriptions). Use the *full probability distribution* as soft genre evidence.
  - One **Choice** over decades
  - A **Noul** "prefers well-known hits over deep cuts"

  Fold the results in as one extra evidence update with weight `w_ai = JEV_WEIGHT × confidence`.
- **T2:** one call, `state` = profile summary. One **Score** question per candidate (≤150). Instructions embed the track text (keys aren't seen by the model). Sort by score. Cheap.
- **T4:** per batch of tracks, Score questions per dim. At current pricing, a few hundred thousand tracks should cost single-digit dollars *(estimate; measure on a 1k sample first)*.

### 10.4 Guardrails

- The AI **can never introduce a track that isn't in the catalog**. Validate ids as a subset, dedupe, and fill gaps deterministically.
- Schema-validate every response, retry once, then fall back to the classic engine with a UI notice.
- Timeouts: 20 s local, 10 s cloud.
- Cache every AI response by `sha256(provider, model, task, input)`.
- **Sensitive answers are excluded from AI payloads** unless the user ticks a per-session opt-in that explains where the data goes.

### 10.5 Prompts

Version prompts as files (`/packages/ai/prompts/*.md`) with golden tests against a mock provider.

---

## 11. Connectors

### 11.1 Spotify (bring-your-own Client ID)

- **Setup wizard + `SELF_HOSTING.md`:**
  1. Create an app in the Spotify dashboard (owner needs Premium)
  2. Select Web API
  3. Add redirect `http://127.0.0.1:<port>/callback`
  4. Add up to 4 other users to the allowlist
  5. Paste the Client ID into `.env`
- **Auth:** Authorization Code + PKCE. Scopes `playlist-modify-private playlist-modify-public`. Refresh-token handling. Tokens encrypted at rest (self-host) and never logged.
- **Push:**
  1. `POST /me/playlists` (private by default; name = title; description includes "Made with Either FM")
  2. Match tracks
  3. `POST /playlists/{id}/items` in batches of ≤100
- **Matching:**
  1. `GET /search?q=isrc:<ISRC>&type=track&limit=1` for each ISRC until a hit
  2. Fallback: `track:"<title>" artist:"<artist>"`, `limit` ≤ 10, accepted only if normalized title similarity ≥ 0.85 and an artist matches
  3. **Backfill** unmatched tracks with the next-best candidates from the same cell, so the final count = N
  4. Report the match rate in the UI
- **Errors:**

  | Code | Meaning | Handling |
  |---|---|---|
  | 401 | expired token | refresh, retry once |
  | 403 | user not on allowlist / owner Premium lapsed | actionable message linking to the setup guide |
  | 429 | rate limit | honor `Retry-After` |
  | 429 + `QUOTA_EXCEEDED` | quota exhausted | stop, tell the user, offer export |

- **Budget:** a 50-track push ≈ 50–80 calls. Minimize calls and keep a local match cache only if the Policy permits.

### 11.2 Export (always available, no account)

- **M3U** (`#EXTM3U` / `#EXTINF` artist – title)
- **XSPF** (with ISRC/MBID identifiers)
- **CSV** (title, artist, album, year, ISRC, MBID). Must import cleanly into common playlist-transfer tools.
- **JSON** (full, including profile + seed)

### 11.3 v2: Apple Music

MusicKit (requires an Apple Developer Program membership). Design the connector interface now so it slots in.

---

## 12. MCP server

stdio transport (HTTP optional). Tools:

| Tool | Purpose |
|---|---|
| `list_questions(pack?, limit?)` | Let the host model read the bank |
| `start_quiz(mode, length?, packs?)` → `{session_id, question}` | Interactive play |
| `answer(session_id, choice: a\|b\|both\|skip)` → next question or done | |
| `submit_answers(answers[{id, choice}], length?)` → `{profile, archetype}` | **Key path:** Claude answers the quiz on the user's behalf from a natural-language description, so no server-side LLM is needed |
| `generate_playlist(session_id \| profile \| share_code, length?, seed?, tweak?)` | |
| `get_profile(session_id \| share_code)` | |
| `export_playlist(playlist_id, format)` → file path / content | |
| `push_to_spotify(playlist_id, name?)` | Requires a completed OAuth in the web app; returns a link or a clear error |

**Acceptance:** from "make me a playlist for a rainy Sunday" in Claude Code to an exported playlist, using only MCP tools.

---

## 13. Privacy and safety

- **Stateless by default:** no accounts, no answer storage server-side, no telemetry. Sessions live client-side.
- **`sensitive` questions** (e.g. political) are excluded from:
  - server logs and analytics
  - AI payloads (unless explicitly opted in per session)
  - share payloads (which contain only the quantized profile anyway)
- Political opinions are special-category data under GDPR. We avoid processing them server-side rather than building consent flows.
- Spotify tokens: encrypted, scoped minimally, deletable via "Disconnect".
- **No artist photos.** Labels + emoji only. Album covers via Cover Art Archive hotlinks, optional.

---

## 14. Configuration (`.env`, documented in `.env.example`)

```
APP_BASE_URL=http://127.0.0.1:8787
CATALOG_PATH=./data/catalog/catalog-2026.10      # or DATABASE_URL if you choose a server DB
SPOTIFY_CLIENT_ID=
SPOTIFY_REDIRECT_URI=http://127.0.0.1:8787/callback
TOKEN_ENCRYPTION_KEY=
AI_PROVIDER=none            # none | openai_compat | openrouter | anthropic
AI_BASE_URL=http://127.0.0.1:8080/v1
AI_MODEL=
AI_API_KEY=
OPENROUTER_API_KEY=
JEV_ENABLED=false
JEV_MODEL=typesafe/jev-1.13
JEV_WEIGHT=2.0
RERANK_BACKEND=none         # none | llm | jev
ALLOW_SENSITIVE_TO_AI=false
SPICY_PACK_DEFAULT=off
```

**Updated in M7 (2026-10-03):** `AI_PROVIDER` is `none | openai_compat`; `OPENROUTER_API_KEY` and `JEV_*` are dropped; `AI_TIMEOUT_MS` and `AI_REASONING_EFFORT` are added; `RERANK_BACKEND` is `none | llm`. `ALLOW_SENSITIVE_TO_AI` lets the setup screen offer the per-session opt-in (§10.4). `.env.example` is the reference.

---

## 15. Milestones (each ends green in CI with its acceptance checks)

| M | Scope | Done when |
|---|---|---|
| **M0** | ADR-0001 stack · scaffold · CI · docker-compose · LICENSE/CONTRIBUTING · YAML schema + `lint` CLI | `lint` passes on `seed.yaml`; compose boots a hello page on Win/macOS/Linux |
| **M1** | Catalog pipeline · dev sample · 5k fixture · quality report · DATA_LICENSES.md | Dev sample builds < 10 min; report shows coverage incl. Hebrew/French; licenses recorded |
| **M2** | Engine: profile fold, selection, pacing, unlock, Both/Skip/Back, "10 more" | Determinism property tests pass (§16 #2, #6) |
| **M3** | Generator: scoring, cells, constraints, sequencing, seeds, archetypes · **eval harness** | §16 #3–#5 pass on the full catalog |
| **M4** | Web UI: setup, quiz (keyboard/swipe), result, export | Usable end-to-end on a phone and desktop |
| **M5** | Spotify connector + setup wizard + docs | §16 #7 passes against a real dev-mode app |
| **M6** | Share card PNG + share links | Link reproduces an identical playlist in a fresh browser |
| **M7** | AI layer: providers, T1–T3, Jev, cache, privacy gates · T4 script | §16 #8, #9 pass with a mock provider; manual check with local llama.cpp + Jev *(2026-10-03: local models only, checked with LM Studio; no Jev, see §10.1)* |
| **M8** | MCP server | §16 #11 |
| **M9** | v0.1 release: README with GIF, SELF_HOSTING, QUESTION_AUTHORING, demo video script | Fresh-machine install by following the docs only |

---

## 16. Acceptance criteria (v0.1)

1. **Install:** `docker compose up` + one documented catalog command gives a working app on a clean machine (dev sample).
2. **Determinism:** 1,000 random answer logs, each generated twice in separate processes, give byte-identical ordered track lists. The same holds for share links.
3. **Performance:** with AI off, p95 < 2 s to generate 50 tracks from the full ~2M catalog on an 8-core laptop.
4. **Constraints:** 100% of generated playlists satisfy §9.3.
5. **Personalization grows with depth:** on the persona eval (§17), mean persona-fit rises from 10 → 20 → 50 → 100 questions, and 100-question playlists beat 10-question ones by a margin set and recorded in M3.
6. **Coverage:** in ≥ 95% of random 10-question runs, at least 7 of 9 scalar dims and both decades and genres receive evidence.
7. **Spotify:**
   - Private playlist created with exactly N tracks
   - ≥ 90% first-pass match rate for tracks with ISRC
   - 401 / 403 / 429 / QUOTA_EXCEEDED each handled as specified
8. **AI robustness:** with a mock provider returning malformed, oversized or hallucinated output, the app still returns a valid playlist and never includes non-catalog tracks.
9. **Privacy:** an automated test asserts that sensitive answers never appear in server logs, AI request payloads (opt-in off), or share payloads.
10. **Question bank:** `lint` passes (§8.4).
11. **MCP:** the Claude Code flow in §12 works end-to-end.
12. **Golden selection sequences.** A spec-literal reference simulation of §7–§8 over `seed.yaml` (default packs, spicy off) produces these first 10 questions. Your engine must match them until you deliberately change the selection rules; if so, update this table and log why in DECISIONS.md.
    - Always answering **A**: `bonjovi_britney, dancefloor_carcry, classical_edm, gym_yoga, english_world, heavy_smooth, hits_gems, scifi_romance, fresh_timeless, adele_dualipa`
    - Always answering **B**: `bonjovi_britney, heavy_smooth, classical_edm, scifi_romance, bubblegum_artpop, english_world, dancefloor_carcry, matrix_titanic, fresh_timeless, adele_dualipa`

    **Updated in M3 (2026-10-02, see DECISIONS.md):** the persona eval chose to normalize IG by key count after the 3-question hook (§18). The engine's sequences are now:
    - Always answering **A**: `bonjovi_britney, dancefloor_carcry, classical_edm, horror_comedy, hits_gems, fast_slow, dec70_dec00, ai_handmade, english_world, simple_complex`
    - Always answering **B**: `bonjovi_britney, heavy_smooth, classical_edm, horror_comedy, hits_gems, simple_complex, dancefloor_carcry, ai_handmade, fast_slow, english_world`

    The original table above is still reproduced with `igNorm: "none"` (§8.3 as written), and a test pins both.

    **2026-10-03:** the bank grew past the seed (`more.yaml`, `il.yaml`), so both tables are pinned on a frozen copy of the seed as of M3 (`packages/cli/test/fixtures/m3-bank/`), with no quiz seed. The live bank's first cards are a snapshot test instead.

    **2026-10-03, later:** the genre-duel bonus (§8.3) leaves the M3 table unchanged. The brief's original table is reproduced with `igNorm: "none"` and `duel: 0`.

---

## 17. Evaluation harness

- **Personas** (`data/personas/*.yaml`, ≥ 12): target clusters, decades and scalar ranges. Examples:
  - 80s pop nostalgic
  - 2000s metalhead
  - jazz & soul dinner host
  - modern hip-hop/R&B
  - indie folk introvert
  - EDM festival
  - classical + soundtrack
  - Hebrew-mizrahi party
  - French chanson + French touch
  - workout high-tempo
  - lo-fi focus
  - "everything mainstream"
- **Persona answerer:** a deterministic bot that picks whichever option's `fx` is closer to the persona targets.
- **Metrics per mode:**
  - Persona-fit (share of tracks in target clusters × decades × scalar ranges)
  - Intra-playlist diversity
  - Artist spread
  - Constraint violations (must be 0)
- **Outputs:**
  - `docs/eval/<date>.md` with tables
  - Printed playlists for human eyeballing
  - Snapshot tests on 3 personas to catch regressions

---

## 18. Risks and open items

| Risk | Mitigation |
|---|---|
| Spotify tightens Dev Mode further (it changed 3× in 18 months) | Export always works; connector isolated; docs explain BYO-key limits honestly |
| Post-2022 music lacks AcousticBrainz features → "my playlist feels old" | Tiers 2–4 imputation, measured MAE, report post-2022 coverage; boost `dec20` evidence quality |
| AB classifier noise | `feature_confidence` in scoring; eval-tuned weights |
| Popularity data skews Western / tech-savvy | Per-country coverage quota in selection; measure IL/FR/ES coverage in M1 |
| MusicBrainz tag licensing (NC-SA) | Separate artifact license, or build-locally path |
| Jev is alpha, proprietary, nondeterministic at the margins | Optional, cached, adapter-isolated |
| Question quality *is* the product | QUESTION_AUTHORING.md, lint, review checklist, opt-in feedback export to tune weights; grow the bank to ≥ 300 via community packs |
| 100-question mode can exhaust the eligible pool. Reference sim, 1,000 random runs: 10/20/50 always complete; 100 runs out in ~15% of sessions (worst case 88 answers) | Early finish message; prioritize growing `deep` packs |
| Information-gain scoring favors multi-key questions, so iconic two-key ones (`dec80_dec90`) never reach the first 10 | Tune in M3: normalize IG by key count, raise `pri`, or pin a "signature" slot. Decide with the persona eval, not by feel |

---

## 19. References

- Spotify — Feb 2026 Dev Mode migration guide: https://developer.spotify.com/documentation/web-api/tutorials/february-2026-migration-guide
- Spotify — Dev Mode quota updates (Jul 2026): https://developer.spotify.com/blog/2026-07-23-web-api-quota-updates
- Spotify — Insecure redirect URI migration: https://developer.spotify.com/documentation/web-api/tutorials/migration-insecure-redirect-uri
- Spotify — Developer Terms / Policy: https://developer.spotify.com/terms · https://developer.spotify.com/policy
- Jev on OpenRouter (API, primitives, pricing): https://openrouter.ai/blog/insights/what-is-jev/
- TypeSafe docs: https://docs.typesafe.ai
- ListenBrainz popularity API: https://listenbrainz.readthedocs.io/en/latest/users/api/popularity.html
- ListenBrainz datasets (popular recordings, per country): https://datasets.listenbrainz.org/
- ListenBrainz data dumps: https://listenbrainz-server.readthedocs.io/en/latest/dev/listenbrainz-dumps.html
- AcousticBrainz final dumps announcement: https://community.metabrainz.org/t/acousticbrainz-data-dumps/591961
- MusicBrainz database/dumps: https://musicbrainz.org/doc/MusicBrainz_Database
