# Contributing to ABTune

Thanks for helping. The two most useful contributions are **better questions** and **better code**, in that order: question quality *is* the product.

## Adding questions (no code needed)

1. Add a file under `data/questions/`, e.g. `data/questions/synthwave.yaml`:

   ```yaml
   # yaml-language-server: $schema=./schema.json
   version: 1
   packs:
     synthwave: { weight: 1.0, default: false }
   questions:
     - id: outrun_darksynth          # snake_case, stable forever
       pack: synthwave
       pri: 60                       # 0–100 authoring priority
       unlock_if: { top_genres: [synth_newwave] }
       a: { label: "Outrun", emoji: "🌅", fx: { synth_newwave: 0.8, valence: 0.4 } }
       b: { label: "Darksynth", emoji: "🌑", fx: { synth_newwave: 0.8, intensity: 0.6, valence: -0.5 } }
   ```

   With the YAML extension for VS Code, the `$schema` line gives you autocomplete for every dimension key.

2. Run `pnpm abtune lint` (lints your file together with the seed) and fix what it reports.

3. If you have a catalog installed, run `pnpm abtune eval`. It replays the quiz with 12 eval personas from [`data/personas/`](data/personas) and shows whether playlists still fit them. Changes to `seed.yaml` change everyone's quiz and playlists, so say in the PR what the eval showed. CI runs the persona snapshot tests (`vitest -u` updates them when a change is intended).

4. Open a pull request.

### Authoring rules

The linter enforces most of these. [docs/QUESTION_AUTHORING.md](docs/QUESTION_AUTHORING.md) explains what each field and dimension means, how the quiz picks cards, and every lint rule:

- `fx` keys must be dimensions from `seed.yaml`, with values in [-1, 1]. Scalars (energy, valence, …) are the *target position* an answer implies; genres, decades and languages are *evidence* (negative = away from).
- Labels are 22 characters or fewer, so they fit a phone card.
- Use `true`/`false`, never `yes`/`no`/`on`/`off`.
- `unlock_if.any` entries look like `"question_id=a"`.
- **Fun/vibe questions map to sonic feel only** (energy, mood, texture, tempo), never to demographic stereotypes.
- **No answer may map a political, religious, ethnic, national or other identity choice to a genre or language.** Mark such questions `sensitive: political` (or similar): they may then only touch scalar dims, with |v| ≤ 0.4. Reviewers enforce the spirit of this rule beyond what lint can check.

## Improving genre mapping (no code needed)

[`data/tag_map.yaml`](data/tag_map.yaml) maps MusicBrainz tags to ABTune's 24 genre clusters, for example `synth-pop: { synth_newwave: 1 }` or `progressive rock: { classic_rock: 1, complexity: 0.8 }`. Each catalog report ends with an "Unmapped tags" table listing the most common tags the map doesn't cover yet. Map tags by **sound**, never by place or identity: `israeli` or `british` stay unmapped. The catalog tests check the map against the bank's dimensions (`pnpm test`).

## Code

- Node 24+, pnpm 10. `pnpm install`, then `pnpm test`, `pnpm typecheck`, `pnpm lint`.
- `packages/engine` is pure: no network, filesystem, clock or `Math.random`. All randomness comes from an explicit seed, and every change must keep identical inputs producing identical outputs.
- Log non-obvious choices as one line in [docs/DECISIONS.md](docs/DECISIONS.md).
- Keep pull requests focused, and make sure CI passes.

By contributing you agree your contributions are licensed under the [MIT License](LICENSE).
