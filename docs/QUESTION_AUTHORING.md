# Writing questions

Question quality *is* the product. A playlist can only be as good as what the cards learn about
someone, so a sharp, fun card is worth more than most code changes. Cards are plain YAML; you don't
need to write code to add them.

Every `data/questions/*.yaml` file is loaded and merged. `seed.yaml` holds the dimensions and the
core packs; `more.yaml`, `variants.yaml`, `duels.yaml` and `il.yaml` add to it. A new pack is a new
file. [CONTRIBUTING.md](../CONTRIBUTING.md) has the step-by-step for a pull request.

## A card

```yaml
- id: bonjovi_britney          # snake_case, unique, stable forever (seeds and share links use it)
  pack: core                   # which pack it belongs to
  pri: 95                      # 0–100: how much you want it asked
  q: "Bon Jovi or Britney?"    # optional; default "<a.label> or <b.label>?"
  weight: 1.0                  # optional multiplier on the pack's weight
  sensitive: political         # optional; see "Sensitive cards" below
  unlock_if:                   # optional; the card is eligible once ANY condition holds
    any: ["rock_pop=a"]        #   an earlier answer
    top_genres: [metal]        #   a genre in the listener's current top 3
    all_top_genres: [metal, edm] # all of these in the top 3 (a "duel" between them)
  family: some_card_id         # optional: this card is a variant of that one
  a: { label: "Bon Jovi", emoji: "🎸", fx: { classic_rock: 1, dec80: 0.8 } }
  b: { label: "Britney Spears", emoji: "💃", fx: { pop: 0.8, dance_pop: 0.8 } }
```

Start the file with `# yaml-language-server: $schema=./schema.json` and VS Code's YAML extension
autocompletes every field and dimension.

## What an answer means: `fx`

Each side's `fx` says what picking it tells us, as `{dimension: value}` with values in [-1, 1].

- **Scalars** are a *position* on an axis: picking this side means the listener wants songs around
  that value. `energy`, `valence` (mood, dark to bright), `dance`, `acoustic`, `intensity`, `tempo`,
  `mainstream` (deep cuts to hits), `vocal` and `complexity`.
- **Decades, genres and languages** are *evidence*, added up over the quiz; negative means "away
  from". Decades are `dec50` (up to 1959) … `dec20` (2020 on). There are 24 genre clusters
  (`classic_rock`, `alt_indie`, `metal`, … `mizrahi`, `kpop`; the list is at the top of
  `seed.yaml`) and five languages (`lang_en`, `lang_he`, `lang_fr`, `lang_es`, `lang_other`).

**Both** counts as half an answer for the average of the two sides, and **Skip** changes nothing.
A side's weight is the pack's weight × the card's `weight`.

Keep the contrast clear: the two sides should differ on one to three things. A card where both
sides say the same thing teaches the quiz nothing and is rarely asked.

## Packs

| pack | weight | what goes in it |
|---|---:|---|
| `core` | 1.0 | Big, clear contrasts anyone can answer: artists everyone knows, eras, moods |
| `context` | 0.8 | When and where you listen ("Road trip or study session?") |
| `deep` | 1.0 | Follow-ups that unlock once a genre leads (`unlock_if`): this genre's sub-styles, artists, duels |
| `vibe` | 0.4 | Fun cards that map to sound only ("Cats or dogs?" → energy, mood) |
| `spicy` | 0.25 | Opt-in, and only touches scalars (see below) |
| `il` | 1.0 | The Israeli music pack, on by default in Israel |

A community pack declares itself in its own file:

```yaml
version: 1
packs:
  synthwave: { weight: 1.0, default: false }   # opt_in: true keeps it off unless chosen
questions:
  - id: outrun_darksynth
    pack: synthwave
    ...
```

## How the quiz picks the next card

1. **Eligible** cards: not asked yet, pack switched on, `unlock_if` met (or absent).
2. **The slot** for this position: the first three are `core` (the hook), every fourth is `vibe`,
   positions 5, 9, 13 and 17 explore a genre or decade nothing has asked about yet, and with spicy on,
   position 7, 17, 27 and so on are `spicy`. Otherwise it's `core`, `context` or `deep`.
3. **The score**: how much the card would teach right now (dimensions the quiz is still unsure
   about count more), times `0.5 + pri/100`. Past 20 answers, cards that split the listener's two
   leading genres get a bonus.
4. **The pick**: each session has a random quiz seed, so the card is a seeded draw among those
   scoring close to the best. Retakes ask a different mix, and the same seed with the same answers
   always gives the same quiz and playlist.

So `pri` is a nudge, not an order: a high-priority card that teaches nothing new still loses to a
useful one.

## Variants

A variant (`family: <canonical id>`) asks the same contrast in other words or with other faces:
"Hotel California or Thriller?" next to "Stairway to Heaven or Billie Jean?". A family is asked at
most once per session, and the seed picks which variant. A variant:

- keeps its canonical card's `pack`, the same `fx` keys and the same A/B meaning (the ones in
  `variants.yaml` copy `fx` and `pri` exactly), so it can't change what an answer means;
- points at the canonical card, never at another variant, and has no `unlock_if` of its own.

## Writing a good card

- **Both sides should be tempting.** "Queen or a car alarm?" is not a question.
- **Use names people know**, or gate lesser-known ones behind `unlock_if` so only fans see them.
- **Labels are 22 characters or fewer**, so they fit a phone card. Pick an emoji for each side.
- **Vibe cards map to sound only**: energy, mood, texture, tempo. Never to a demographic.
- **Use `true`/`false`**, never `yes`/`no`/`on`/`off` (some YAML parsers turn those into booleans).

## Sensitive cards

**No answer may map a political, religious, ethnic, national or other identity choice to a genre or
language.** A card that touches anything like that is marked `sensitive: political` (or similar),
may only move scalar dimensions, and by at most 0.4. Sensitive cards live in the opt-in spicy pack.
Lint checks the numbers; reviewers check the spirit.

## Checking your cards

```sh
pnpm abtune lint     # schema and rules, your file together with the rest of the bank
pnpm abtune sim      # replays the quiz: how often each card is asked, early endings
pnpm abtune eval     # with a catalog installed: do the 12 eval personas still get fitting playlists?
```

What `lint` reports:

| rule | meaning |
|---|---|
| `id-format`, `id-unique` | ids are snake_case and unique |
| `pack-unknown`, `pack-name` | the pack is declared under `packs:`, with a snake_case name |
| `label-length` | a label is over 22 characters |
| `fx-empty`, `fx-unknown-key`, `fx-range` | each side has effects, on real dimensions, in [-1, 1] |
| `sensitive-fx` | a sensitive card touches a non-scalar, or goes past ±0.4 |
| `unlock-ref`, `unlock-genre` | `unlock_if` names an existing `id=a`/`id=b` and real genres |
| `family` | a variant points at a canonical card in the same pack, with no `unlock_if` |
| `coverage-scalar`, `coverage-genre` | every scalar is touched by at least 5 core/context cards, every genre by at least 3 |

Changing a card changes everyone's quiz: the bank's hash is part of every playlist seed, and share
links made before the change say "made with another version". That's fine, but mention what
`pnpm abtune eval` showed in the pull request.
