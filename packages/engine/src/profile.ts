import { bankIndex, type DimKind, dimOf, GROUPS, type GroupName } from "./dims.ts";
import type { Bank, Choice, Question } from "./types.ts";

export interface AnswerEvent {
  readonly id: string;
  readonly choice: Choice;
}

/** Scalar dim: target position μ in [-1, 1] and accumulated confidence C. */
export interface ScalarState {
  readonly mu: number;
  readonly c: number;
}

/** Categorical group: additive scores s_c and total absolute evidence E_G. */
export interface GroupState {
  readonly s: Readonly<Record<string, number>>;
  readonly evidence: number;
}

export interface Profile {
  readonly scalars: Readonly<Record<string, ScalarState>>;
  readonly groups: Readonly<Record<GroupName, GroupState>>;
  /** Non-skip answers folded in. */
  readonly answered: number;
}

export interface FoldOptions {
  /** Prior confidence C for every scalar (HANDOFF §7.3 PRIOR_WEIGHT). */
  readonly priorWeight?: number;
}

export const PRIOR_WEIGHT = 1;
/** HANDOFF §7.2: a "Both!" answer counts half, applied to the average of both sides. */
export const BOTH_MULTIPLIER = 0.5;

/** The effects an answer applies and its multiplier, or null for a skip. */
export function answerEffects(
  question: Question,
  choice: Choice,
): { fx: Readonly<Record<string, number>>; mult: number } | null {
  switch (choice) {
    case "skip":
      return null;
    case "a":
    case "b":
      return { fx: question[choice].fx, mult: 1 };
    case "both": {
      // Union of keys in a-then-b order; a missing key counts as 0.
      const fx: Record<string, number> = {};
      for (const key of [...Object.keys(question.a.fx), ...Object.keys(question.b.fx)]) {
        if (key in fx) continue;
        fx[key] = ((question.a.fx[key] ?? 0) + (question.b.fx[key] ?? 0)) / 2;
      }
      return { fx, mult: BOTH_MULTIPLIER };
    }
  }
}

interface Effect {
  readonly key: string;
  readonly dim: DimKind;
  readonly v: number;
}
type SideEffects = { readonly effects: readonly Effect[]; readonly mult: number };
type QuestionEffects = Readonly<Record<"a" | "b" | "both", SideEffects>>;

const effectsCache = new WeakMap<Bank, Map<string, QuestionEffects>>();

/** answerEffects for every question and non-skip choice, resolved to dimensions once per bank. */
function bankEffects(bank: Bank): Map<string, QuestionEffects> {
  let cached = effectsCache.get(bank);
  if (!cached) {
    const { registry } = bankIndex(bank);
    cached = new Map();
    for (const q of bank.questions) {
      const resolve = (choice: "a" | "b" | "both"): SideEffects => {
        const e = answerEffects(q, choice) as { fx: Record<string, number>; mult: number };
        return {
          effects: Object.entries(e.fx).map(([key, v]) => ({ key, dim: dimOf(registry, key), v })),
          mult: e.mult,
        };
      };
      cached.set(q.id, { a: resolve("a"), b: resolve("b"), both: resolve("both") });
    }
    effectsCache.set(bank, cached);
  }
  return cached;
}

export function emptyProfile(
  bank: Bank,
  { priorWeight = PRIOR_WEIGHT }: FoldOptions = {},
): Profile {
  const scalars: Record<string, ScalarState> = {};
  for (const key of bank.dimensions.scalar) scalars[key] = { mu: 0, c: priorWeight };
  const groups = {} as Record<GroupName, GroupState>;
  for (const group of GROUPS) {
    const s: Record<string, number> = {};
    for (const key of bank.dimensions[group]) s[key] = 0;
    groups[group] = { s, evidence: 0 };
  }
  return { scalars, groups, answered: 0 };
}

/**
 * HANDOFF §7.3: the profile is a pure fold over the answer log.
 *   scalars:      μ ← (C·μ + w·v) / (C + w),  C ← C + w
 *   categoricals: s_c ← s_c + w·v,  E_G ← E_G + |w·v|
 * with w = pack.weight × question.weight × answer multiplier.
 */
export function foldProfile(
  bank: Bank,
  log: readonly AnswerEvent[],
  options: FoldOptions = {},
): Profile {
  const { byId } = bankIndex(bank);
  const effectsById = bankEffects(bank);
  const start = emptyProfile(bank, options);
  const scalars = Object.fromEntries(
    Object.entries(start.scalars).map(([k, v]) => [k, { ...v }]),
  ) as Record<string, { mu: number; c: number }>;
  const groups = {} as Record<GroupName, { s: Record<string, number>; evidence: number }>;
  for (const group of GROUPS) groups[group] = { s: { ...start.groups[group].s }, evidence: 0 };
  let answered = 0;

  for (const event of log) {
    const question = byId.get(event.id);
    if (!question) throw new Error(`Answer log references unknown question "${event.id}".`);
    if (event.choice === "skip") continue;
    const side = (effectsById.get(event.id) as QuestionEffects)[event.choice];
    answered++;
    const w = questionWeight(bank, question) * side.mult;
    for (const { key, dim, v } of side.effects) {
      if (dim.kind === "scalar") {
        const state = scalars[key] as { mu: number; c: number };
        state.mu = (state.c * state.mu + w * v) / (state.c + w);
        state.c += w;
      } else {
        const g = groups[dim.group];
        g.s[key] = (g.s[key] ?? 0) + w * v;
        g.evidence += Math.abs(w * v);
      }
    }
  }
  return { scalars, groups, answered };
}

/** pack.weight × question.weight (HANDOFF §7.2), before the answer multiplier. */
export function questionWeight(bank: Bank, question: Question): number {
  const pack = bank.packs[question.pack];
  if (!pack) throw new Error(`Question "${question.id}" is in unknown pack "${question.pack}".`);
  return pack.weight * question.weight;
}

/** Group categories with s_c > 0, highest first; ties keep declaration order. */
export function topCategories(bank: Bank, profile: Profile, group: GroupName, n: number): string[] {
  const s = profile.groups[group].s;
  return bank.dimensions[group]
    .map((key, index) => ({ key, index, score: s[key] ?? 0 }))
    .filter((x) => x.score > 0)
    .sort((x, y) => y.score - x.score || x.index - y.index)
    .slice(0, n)
    .map((x) => x.key);
}

/**
 * p_G = softmax(s / τ) in declaration order, or null when the group has no evidence
 * (E_G = 0: no preference, so ranking uses the catalog's natural distribution).
 */
export function groupDistribution(
  bank: Bank,
  profile: Profile,
  group: GroupName,
  tau: number,
): Readonly<Record<string, number>> | null {
  const state = profile.groups[group];
  if (state.evidence === 0) return null;
  const keys = bank.dimensions[group];
  const logits = keys.map((k) => (state.s[k] ?? 0) / tau);
  const max = Math.max(...logits);
  const exps = logits.map((l) => Math.exp(l - max));
  const total = exps.reduce((a, b) => a + b, 0);
  const out: Record<string, number> = {};
  keys.forEach((k, i) => {
    out[k] = (exps[i] ?? 0) / total;
  });
  return out;
}
