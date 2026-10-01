import { bankIndex } from "./dims.ts";
import { type AnswerEvent, type Profile, questionWeight, topCategories } from "./profile.ts";
import type { Bank, Question } from "./types.ts";

/** Packs with fixed pacing slots. Every other enabled pack (core, context, deep, community) is "main". */
export const HOOK_PACK = "core";
export const VIBE_PACK = "vibe";
export const SPICY_PACK = "spicy";

export type SlotKind = "hook" | "vibe" | "spicy" | "main";

/**
 * HANDOFF §8.3 pacing for 1-based `position`:
 * 1–3 core only (the hook) · every 4th vibe · 7, 17, 27… spicy (if enabled) · otherwise main.
 */
export function slotFor(position: number, spicyEnabled: boolean): SlotKind {
  if (position <= 3) return "hook";
  if (position % 4 === 0) return "vibe";
  if (spicyEnabled && position % 10 === 7) return "spicy";
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
    case "main":
      return pack !== VIBE_PACK && pack !== SPICY_PACK;
  }
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

/** Current genre top 3 used by `unlock_if.top_genres`. */
export const UNLOCK_TOP_GENRES = 3;

/**
 * Eligible = not yet asked (skips count as asked), pack enabled, and `unlock_if` satisfied:
 * any listed answer is in the log (a "both" answer satisfies =a and =b), or any listed genre
 * is in the current top 3 with s_c > 0.
 */
export function eligibleQuestions(
  bank: Bank,
  profile: Profile,
  log: readonly AnswerEvent[],
  enabledPacks: ReadonlySet<string>,
): Question[] {
  const choices = new Map(log.map((e) => [e.id, e.choice]));
  const refsById = unlockRefs(bank);
  let top: Set<string> | undefined;
  return bank.questions.filter((q) => {
    if (choices.has(q.id) || !enabledPacks.has(q.pack)) return false;
    const unlock = q.unlock_if;
    if (!unlock) return true;
    for (const ref of refsById.get(q.id) ?? []) {
      const choice = choices.get(ref.id);
      if (choice === ref.side || choice === "both") return true;
    }
    if (!unlock.top_genres) return false;
    top ??= new Set(topCategories(bank, profile, "genres", UNLOCK_TOP_GENRES));
    return unlock.top_genres.some((g) => top?.has(g));
  });
}

/**
 * HANDOFF §8.3 information gain:
 *   u(k) = 1 / C_k for scalars, 1 / (1 + E_G(k)) for categoricals
 *   IG(q) = Σ_k |fx_a[k] − fx_b[k]| · u(k) · w_q,  score = IG · (0.5 + pri/100)
 */
export function scoreQuestion(bank: Bank, profile: Profile, question: Question): number {
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
  return ig * (0.5 + question.pri / 100);
}

/** Code-unit comparison: locale-independent, so ordering is identical on every machine. */
export function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The next question for 1-based `position`, or null when nothing is eligible.
 * Deterministic: highest score wins, ties broken by id. No randomness.
 */
export function nextQuestion(
  bank: Bank,
  profile: Profile,
  log: readonly AnswerEvent[],
  enabledPacks: ReadonlySet<string>,
  position: number,
): Question | null {
  const eligible = eligibleQuestions(bank, profile, log, enabledPacks);
  if (eligible.length === 0) return null;
  const slot = slotFor(position, enabledPacks.has(SPICY_PACK));
  const inPool = eligible.filter((q) => inSlot(q.pack, slot));
  const pool = inPool.length > 0 ? inPool : eligible;

  let best: Question | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const q of pool) {
    const score = scoreQuestion(bank, profile, q);
    if (score > bestScore || (score === bestScore && best && compareIds(q.id, best.id) < 0)) {
      best = q;
      bestScore = score;
    }
  }
  return best;
}
