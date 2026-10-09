import { bankIndex } from "./dims.ts";
import { sha256Hex } from "./hash.ts";
import { type AnswerEvent, type Profile, questionWeight, topCategories } from "./profile.ts";
import { createRng, type Rng } from "./rng.ts";
import type { Bank, Question } from "./types.ts";

/** Packs with fixed pacing slots. Every other enabled pack (core, context, deep, community) is "main". */
export const HOOK_PACK = "core";
export const VIBE_PACK = "vibe";
export const SPICY_PACK = "spicy";

export type SlotKind = "hook" | "vibe" | "spicy" | "explore" | "lead" | "main";

/** Explore slots (2026-10-04) run through this position: 5, 9, 13 and 17. */
export const EXPLORE_UNTIL = 20;

/**
 * HANDOFF §8.3 pacing for 1-based `position`:
 * 1–3 core only (the hook) · every 4th vibe · 7, 17, 27… spicy (if enabled) · with `explore`,
 * 5, 9, 13, 17 explore (a genre or decade no card has touched yet) · otherwise main. A pack's
 * `lead` position overrides this (see nextQuestion).
 */
export function slotFor(position: number, spicyEnabled: boolean, explore = false): SlotKind {
  if (position <= 3) return "hook";
  if (position % 4 === 0) return "vibe";
  if (spicyEnabled && position % 10 === 7) return "spicy";
  if (explore && position % 4 === 1 && position <= EXPLORE_UNTIL) return "explore";
  return "main";
}

export function inSlot(pack: string, slot: SlotKind): boolean {
  switch (slot) {
    case "hook":
      return pack === HOOK_PACK;
    case "vibe":
      return pack === VIBE_PACK;
    case "spicy":
      return pack === SPICY_PACK;
    case "explore":
    case "lead":
    case "main":
      return pack !== VIBE_PACK && pack !== SPICY_PACK;
  }
}

/**
 * The smallest |fx_a − fx_b| on a key for a card to explore it: the two sides must disagree about
 * it ("Hip-hop or Rock?"), not both lean in (Eminem or Drake: either answer adds hip-hop).
 */
export const EXPLORE_MIN_DIFF = 0.5;

/** Genre and decade keys that some asked card names on either side. */
function touchedKeys(bank: Bank, log: readonly AnswerEvent[]): Set<string> {
  const { byId } = bankIndex(bank);
  const touched = new Set<string>();
  for (const e of log) {
    const q = byId.get(e.id);
    if (!q) continue;
    for (const k of Object.keys(q.a.fx)) touched.add(k);
    for (const k of Object.keys(q.b.fx)) touched.add(k);
  }
  return touched;
}

/** Whether `q` sets a genre or decade nobody has asked about against something else. */
function opensKey(bank: Bank, q: Question, touched: ReadonlySet<string>): boolean {
  for (const k of [...bank.dimensions.genres, ...bank.dimensions.decades]) {
    if (touched.has(k)) continue;
    if (Math.abs((q.a.fx[k] ?? 0) - (q.b.fx[k] ?? 0)) >= EXPLORE_MIN_DIFF) return true;
  }
  return false;
}

interface UnlockRef {
  readonly id: string;
  readonly side: string;
}
const unlockCache = new WeakMap<Bank, Map<string, readonly UnlockRef[]>>();

/** `unlock_if.any` refs parsed once per bank. */
function unlockRefs(bank: Bank): Map<string, readonly UnlockRef[]> {
  let cached = unlockCache.get(bank);
  if (!cached) {
    cached = new Map();
    for (const q of bank.questions) {
      const refs = (q.unlock_if?.any ?? []).map((ref) => {
        const [id = "", side = ""] = ref.split("=");
        return { id, side };
      });
      cached.set(q.id, refs);
    }
    unlockCache.set(bank, cached);
  }
  return cached;
}

/** Question families (`family`), parsed once per bank. */
export interface Families {
  /** Every question id → its family's canonical id (a canonical question maps to itself). */
  readonly familyOf: ReadonlyMap<string, string>;
  /** Canonical id → the family's questions, canonical first, then variants in bank order. */
  readonly members: ReadonlyMap<string, readonly Question[]>;
}
const familyCache = new WeakMap<Bank, Families>();

export function families(bank: Bank): Families {
  let cached = familyCache.get(bank);
  if (!cached) {
    const byId = bankIndex(bank).byId;
    const familyOf = new Map<string, string>();
    const members = new Map<string, Question[]>();
    for (const q of bank.questions) {
      familyOf.set(q.id, q.family !== undefined && byId.has(q.family) ? q.family : q.id);
    }
    for (const q of bank.questions) {
      const canonical = familyOf.get(q.id) as string;
      const list = members.get(canonical) ?? [];
      if (canonical === q.id) list.unshift(q);
      else list.push(q);
      members.set(canonical, list);
    }
    cached = { familyOf, members };
    familyCache.set(bank, cached);
  }
  return cached;
}

/** Current genre top 3 used by `unlock_if.top_genres`. */
export const UNLOCK_TOP_GENRES = 3;

/**
 * Eligible = family not yet asked (skips count as asked), pack enabled, and its canonical
 * question's `unlock_if` satisfied: any listed answer is in the log (a "both" answer satisfies
 * =a and =b; an answer to any variant counts for its family), or any `top_genres` genre is in
 * the current top 3 with s_c > 0, or every `all_top_genres` genre is. Variants of an eligible
 * family are eligible too.
 */
export function eligibleQuestions(
  bank: Bank,
  profile: Profile,
  log: readonly AnswerEvent[],
  enabledPacks: ReadonlySet<string>,
): Question[] {
  const { familyOf } = families(bank);
  const { byId } = bankIndex(bank);
  const fam = (id: string) => familyOf.get(id) ?? id;
  const choices = new Map(log.map((e) => [fam(e.id), e.choice]));
  const refsById = unlockRefs(bank);
  let top: Set<string> | undefined;
  return bank.questions.filter((q) => {
    const canonical = byId.get(fam(q.id)) ?? q;
    if (choices.has(canonical.id) || !enabledPacks.has(canonical.pack)) return false;
    const unlock = canonical.unlock_if;
    if (!unlock) return true;
    for (const ref of refsById.get(canonical.id) ?? []) {
      const choice = choices.get(fam(ref.id));
      if (choice === ref.side || choice === "both") return true;
    }
    if (!unlock.top_genres && !unlock.all_top_genres) return false;
    top ??= new Set(topCategories(bank, profile, "genres", UNLOCK_TOP_GENRES));
    if (unlock.top_genres?.some((g) => top?.has(g))) return true;
    return unlock.all_top_genres?.every((g) => top?.has(g)) ?? false;
  });
}

export type IgNorm = "none" | "sqrt" | "keys";

export interface SelectOptions {
  /**
   * HANDOFF §18: IG favors questions with many fx keys. `sqrt` / `keys` divide IG by the square
   * root of / the number of keys; `none` is §8.3 as written. Default: DEFAULT_IG_NORM.
   */
  readonly igNorm?: IgNorm;
  /** Score the hook (positions 1–3) by §8.3 as written, normalizing only from position 4. */
  readonly rawHook?: boolean;
  /**
   * Weight of the genre-duel bonus: score × (1 + duel · duelValue). 0 = §8.3 without it.
   * Default: DEFAULT_DUEL. The hook never gets it.
   */
  readonly duel?: number;
  /** First 1-based position the duel bonus applies at. Default: DEFAULT_DUEL_FROM. */
  readonly duelFrom?: number;
  /** Explore slots (positions 5, 9, 13, 17). Default: DEFAULT_EXPLORE. */
  readonly explore?: boolean;
}

/**
 * Genre duels (2026-10-03, see DECISIONS.md): how well `question` splits two of the leading
 * genres, in [0, 1]. A forced choice adds evidence to whichever side is picked, so a genre the
 * listener doesn't care about can tie the one they love; only a card that pits the two against each
 * other settles it. Each genre's contender weight is c = s / s_top once s ≥ DUEL_MIN_SCORE, else 0.
 * For each pair of genres the card moves in opposite directions, the value is
 * c₁ · c₂ · min(|Δ₁|, |Δ₂|), and the card scores its best pair: 1 for a full-strength card between
 * two tied leaders.
 */
export function duelValue(bank: Bank, profile: Profile, question: Question): number {
  const s = profile.groups.genres.s;
  let top = 0;
  for (const g of bank.dimensions.genres) top = Math.max(top, s[g] ?? 0);
  if (top <= 0) return 0;
  const diffs: { c: number; d: number }[] = [];
  for (const g of bank.dimensions.genres) {
    const d = (question.a.fx[g] ?? 0) - (question.b.fx[g] ?? 0);
    const sg = s[g] ?? 0;
    const c = sg >= DUEL_MIN_SCORE ? sg / top : 0;
    if (d !== 0 && c > 0) diffs.push({ c, d });
  }
  let best = 0;
  for (let i = 0; i < diffs.length; i++) {
    for (let j = i + 1; j < diffs.length; j++) {
      const x = diffs[i] as { c: number; d: number };
      const y = diffs[j] as { c: number; d: number };
      if (x.d * y.d >= 0) continue;
      best = Math.max(best, x.c * y.c * Math.min(Math.abs(x.d), Math.abs(y.d)));
    }
  }
  return best;
}

/** The engine's question-selection rule (set by the M3 persona eval; see DECISIONS.md). */
export const DEFAULT_IG_NORM: IgNorm = "keys";
export const DEFAULT_RAW_HOOK = true;
/**
 * Genre-duel bonus (2026-10-03, set with simulated listeners; see DECISIONS.md). Close genre
 * leaders get a card that settles them, so the playlist stops flipping between 50 and 60 answers.
 * It started at card 21 because earlier it pushed out the language card; since the Israeli pack
 * asks that card second (PackDef.lead), it starts at card 6 (2026-10-08): in a 10- or 20-question
 * quiz a hip-hop fan who picked pop artists over rock ones now gets "Rap verses or pop choruses?".
 */
export const DEFAULT_DUEL = 3;
/**
 * A genre is a duel contender once it has a full answer's worth of evidence (2026-10-08). With
 * duels from card 6, picking Britney over Bon Jovi (pop 0.8, dance-pop 0.8) tied two genres that
 * one card raised together, and their duel took a mizrahi fan's 10-question profile to 94%
 * dance-pop.
 */
export const DUEL_MIN_SCORE = 1;
export const DEFAULT_DUEL_FROM = 6;
/**
 * Explore slots (2026-10-04, after the launch review). IG gives every genre one shared
 * uncertainty, so a card about a genre nobody has asked about is worth no more than another
 * rock-vs-pop card: in 20 random cards hip-hop, alt/indie, blues, reggae and K-pop were asked
 * 0–1% of the time, and their deep cards never unlocked. An explore slot asks the
 * highest-priority card that sets an untouched genre or decade against something else.
 */
export const DEFAULT_EXPLORE = true;

/**
 * HANDOFF §8.3 information gain:
 *   u(k) = 1 / C_k for scalars, 1 / (1 + E_G(k)) for categoricals
 *   IG(q) = Σ_k |fx_a[k] − fx_b[k]| · u(k) · w_q,  score = IG · (0.5 + pri/100)
 * then IG ÷ key count (DEFAULT_IG_NORM) and × (1 + duel · duelValue) (DEFAULT_DUEL).
 */
export function scoreQuestion(
  bank: Bank,
  profile: Profile,
  question: Question,
  options: SelectOptions = {},
): number {
  const keyDiffs = bankIndex(bank).keyDiffs.get(question.id) ?? [];
  const wq = questionWeight(bank, question);
  let ig = 0;
  for (const { key, dim, diff } of keyDiffs) {
    const u =
      dim.kind === "scalar"
        ? 1 / (profile.scalars[key]?.c ?? 1)
        : 1 / (1 + profile.groups[dim.group].evidence);
    ig += diff * u * wq;
  }
  const keys = keyDiffs.length;
  const norm = options.igNorm ?? DEFAULT_IG_NORM;
  if (keys > 0 && norm === "keys") ig /= keys;
  else if (keys > 0 && norm === "sqrt") ig /= Math.sqrt(keys);
  const duel = options.duel ?? DEFAULT_DUEL;
  const bonus = duel > 0 ? 1 + duel * duelValue(bank, profile, question) : 1;
  return ig * (0.5 + question.pri / 100) * bonus;
}

/** Code-unit comparison: locale-independent, so ordering is identical on every machine. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * A session's variety (owner decision D7, 2026-10-03; amends locked decision #3 to "same seed +
 * same answers → same path"). Without a seed, selection is §8.3 as written: deterministic, and
 * only canonical questions are asked.
 */
export interface Variety {
  /** 16 hex chars, random per session; null = deterministic. */
  readonly seed: string | null;
  /** Question ids to steer away from when choosing a family's variant (the previous session's). */
  readonly avoid?: readonly string[];
}

/**
 * With a seed, a slot's card is drawn among the questions scoring within this share of the best
 * (weighted by score). Vibe cards are interchangeable moods; main cards discover genres, so their
 * band is narrow; the hook stays the best card, and its family supplies the variety.
 */
export const VARIETY_BAND: Readonly<Record<SlotKind, number>> = {
  hook: 0,
  vibe: 0.6,
  main: 0.1,
  spicy: 0,
  // Explore slots score by priority: a band of 15% keeps the draw among the important cards.
  explore: 0.15,
  // A lead slot asks its pack's most important card; the family supplies the variety.
  lead: 0,
};

/** Integer resolution of the draw's weights (the best candidate weighs this much). */
const DRAW_RESOLUTION = 1 << 16;

/** The draw for the next card: a pure function of the seed and the log so far (Back replays it). */
export function stepRng(seed: string, log: readonly AnswerEvent[]): Rng {
  const path = log.map((e) => `${e.id}=${e.choice}`).join(",");
  return createRng(sha256Hex(`${seed}|${path}`).slice(0, 16));
}

/**
 * The next question for 1-based `position`, or null when nothing is eligible. Families are
 * scored by their canonical question. Without a variety seed: the highest score wins, ties by id,
 * no randomness. With one: a seeded draw within VARIETY_BAND of the best (weighted by score), then
 * a seeded variant of the drawn family, preferring variants not in `avoid`.
 */
export function nextQuestion(
  bank: Bank,
  profile: Profile,
  log: readonly AnswerEvent[],
  enabledPacks: ReadonlySet<string>,
  position: number,
  options: SelectOptions = {},
  variety: Variety = { seed: null },
): Question | null {
  const { familyOf, members } = families(bank);
  const eligible = eligibleQuestions(bank, profile, log, enabledPacks).filter(
    (q) => familyOf.get(q.id) === q.id,
  );
  if (eligible.length === 0) return null;
  let slot = slotFor(position, enabledPacks.has(SPICY_PACK), options.explore ?? DEFAULT_EXPLORE);
  const inPool = eligible.filter((q) => inSlot(q.pack, slot));
  let pool = inPool.length > 0 ? inPool : eligible;
  for (const [pack, def] of Object.entries(bank.packs)) {
    const k = def.lead?.indexOf(position) ?? -1;
    if (k < 0 || !enabledPacks.has(pack)) continue;
    // The k-th lead slot asks the pack's (k+1)-th card at most: a skip leaves the position where
    // it was, and the pack's next card must not take the same slot again.
    const { byId } = bankIndex(bank);
    if (log.filter((e) => byId.get(e.id)?.pack === pack).length > k) continue;
    const led = eligible.filter((q) => q.pack === pack);
    if (led.length > 0) {
      pool = led;
      slot = "lead";
      break;
    }
  }
  if (slot === "explore") {
    const touched = touchedKeys(bank, log);
    const open = pool.filter((q) => opensKey(bank, q, touched));
    if (open.length > 0) pool = open;
    else slot = "main";
  }
  const scoring: SelectOptions =
    slot === "hook" && (options.rawHook ?? DEFAULT_RAW_HOOK)
      ? { igNorm: "none", duel: 0 }
      : position < (options.duelFrom ?? DEFAULT_DUEL_FROM)
        ? { ...options, duel: 0 }
        : options;
  const scored = pool
    .map((q) => ({
      q,
      score:
        slot === "explore" || slot === "lead" ? q.pri : scoreQuestion(bank, profile, q, scoring),
    }))
    .sort((x, y) => y.score - x.score || compareIds(x.q.id, y.q.id));
  const best = scored[0] as { q: Question; score: number };
  if (!variety.seed) return best.q;

  const rng = stepRng(variety.seed, log);
  const floor = best.score * (1 - VARIETY_BAND[slot]);
  const band = scored.filter((c) => c.score >= floor);
  const weights = band.map((c) =>
    best.score > 0 ? Math.max(1, Math.floor((c.score / best.score) * DRAW_RESOLUTION)) : 1,
  );
  let r = rng.int(weights.reduce((a, b) => a + b, 0));
  let k = 0;
  while (r >= (weights[k] as number)) {
    r -= weights[k] as number;
    k++;
  }
  const family = members.get((band[k] as { q: Question }).q.id) ?? [best.q];
  const avoid = new Set(variety.avoid ?? []);
  const fresh = family.filter((q) => !avoid.has(q.id));
  const choices = fresh.length > 0 ? fresh : family;
  return choices[rng.int(choices.length)] as Question;
}
