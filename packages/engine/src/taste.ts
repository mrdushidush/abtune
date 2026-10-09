import { GROUPS, type GroupName } from "./dims.ts";
import { groupDistribution, PRIOR_WEIGHT, type Profile } from "./profile.ts";
import type { Bank, Dimensions } from "./types.ts";

/** Scalar targets are stored as integers in [-TARGET_SCALE, TARGET_SCALE]. */
export const TARGET_SCALE = 100;
/** Scalar confidence weights κ are stored as integers in [0, WEIGHT_SCALE]. */
export const WEIGHT_SCALE = 100;
/** Group distributions are stored as integers summing to about P_SCALE. */
export const P_SCALE = 1000;
/** The scalar that measures popularity (catalog percentile), target of the popularity lean. */
export const POPULARITY_DIM = "mainstream";

/**
 * The generator's whole input about the listener, quantized to integers (HANDOFF §9.5).
 * A share link carries this vector plus the seed, so it reproduces the exact playlist without the
 * answers or the AI layer. Arrays follow the bank's dimension declaration order.
 */
export interface TasteVector {
  /** Per scalar dim: target position × TARGET_SCALE. */
  readonly target: readonly number[];
  /** Per scalar dim: confidence κ × WEIGHT_SCALE (0 = no evidence; the dim is ignored). */
  readonly weight: readonly number[];
  /** Per group: distribution × P_SCALE, or null when the group has no evidence (no preference). */
  readonly decades: readonly number[] | null;
  readonly genres: readonly number[] | null;
  readonly languages: readonly number[] | null;
}

export interface TasteParams {
  /** κ_d = min(1, evidence_d / K) (HANDOFF §9.1, K ≈ 3). */
  readonly confidenceRamp: number;
  /** Softmax temperature τ per categorical group (HANDOFF §7.3). */
  readonly tau: Readonly<Record<GroupName, number>>;
  /**
   * Per group: the temperature grows to this × the top score once that exceeds τ, so deep profiles
   * keep a stable mix instead of collapsing to one category (see groupDistribution). 0 = off.
   */
  readonly relativeTau?: Readonly<Partial<Record<GroupName, number>>>;
  /** Per ordered group (decades): neighbor smoothing before the softmax (see groupDistribution). */
  readonly smooth?: Readonly<Partial<Record<GroupName, number>>>;
  /**
   * `mu`: the fold's μ, which the prior pulls toward 0. `evidence`: the evidence-weighted mean of the
   * answers alone (μ·C / (C − prior)); confidence is then carried by κ only.
   */
  readonly target: "mu" | "evidence";
  /**
   * A virtual answer of this weight toward `mainstream = target`, so weak evidence leans to
   * well-known songs. Real answers (weight 1 each) outweigh it. weight 0 disables it.
   */
  readonly popularityLean: { readonly weight: number; readonly target: number };
}

/**
 * Tuned with the persona eval (M3, see DECISIONS.md); the brief's start: K 3, τ 1, target mu.
 * relativeTau.genres 0.15 was added on 2026-10-03 (the 50-question playlist flipped genres).
 * 2026-10-08, from 200 browser runs and simulated quizzes (DECISIONS "Playlist fit study"): decades
 * τ 0.3 with smoothing 0.3, so a 2010s fan no longer gets 1950s songs after a short quiz, and
 * relativeTau.decades 0.1, so a long quiz keeps the old τ 1 split instead of sharpening without end.
 */
export const DEFAULT_TASTE_PARAMS: TasteParams = {
  confidenceRamp: 5,
  tau: { decades: 0.3, genres: 0.25, languages: 1 },
  relativeTau: { genres: 0.15, decades: 0.1 },
  smooth: { decades: 0.3 },
  target: "evidence",
  popularityLean: { weight: 0.6, target: 0.6 },
};

/** Round to an integer, never -0 (so canonical JSON and equality checks agree). */
function quantize(x: number, scale: number): number {
  const r = Math.round(x * scale);
  return r === 0 ? 0 : r;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Distribution → integers summing to P_SCALE (largest remainder, ties by index). */
export function quantizeDistribution(p: readonly number[]): number[] {
  const total = p.reduce((a, b) => a + b, 0);
  const exact = p.map((x) => (x / total) * P_SCALE);
  const out = exact.map(Math.floor);
  let left = P_SCALE - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, r: x - Math.floor(x) }))
    .sort((a, b) => b.r - a.r || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = (out[i] as number) + 1;
    left--;
  }
  return out;
}

/** Profile (from the answer fold) → quantized taste vector. Pure and deterministic. */
export function tasteVector(
  bank: Bank,
  profile: Profile,
  params: TasteParams = DEFAULT_TASTE_PARAMS,
): TasteVector {
  const target: number[] = [];
  const weight: number[] = [];
  for (const dim of bank.dimensions.scalar) {
    const state = profile.scalars[dim] ?? { mu: 0, c: PRIOR_WEIGHT };
    // The fold starts at μ = 0 with confidence PRIOR_WEIGHT, so Σ w·v = μ·C and Σ w = C − prior.
    let evidence = Math.max(0, state.c - PRIOR_WEIGHT);
    let sum = state.mu * state.c;
    if (dim === POPULARITY_DIM && params.popularityLean.weight > 0) {
      evidence += params.popularityLean.weight;
      sum += params.popularityLean.weight * params.popularityLean.target;
    }
    const t =
      params.target === "evidence"
        ? evidence > 0
          ? sum / evidence
          : 0
        : sum / (PRIOR_WEIGHT + evidence);
    target.push(quantize(clamp(t, -1, 1), TARGET_SCALE));
    weight.push(quantize(clamp(evidence / params.confidenceRamp, 0, 1), WEIGHT_SCALE));
  }
  const groups = {} as Record<GroupName, number[] | null>;
  for (const group of GROUPS) {
    const p = groupDistribution(
      bank,
      profile,
      group,
      params.tau[group],
      params.relativeTau?.[group] ?? 0,
      params.smooth?.[group] ?? 0,
    );
    groups[group] = p ? bank.dimensions[group].map((k) => quantize(p[k] ?? 0, P_SCALE)) : null;
  }
  return { target, weight, ...groups };
}

/** Throws unless `taste` fits `dims`: array lengths and integer ranges (e.g. a decoded share link). */
export function validateTaste(dims: Dimensions, taste: TasteVector): void {
  const ints = (xs: readonly number[], lo: number, hi: number, what: string) => {
    for (const x of xs) {
      if (!Number.isInteger(x) || x < lo || x > hi)
        throw new Error(`taste: bad ${what} value ${x}`);
    }
  };
  if (taste.target.length !== dims.scalar.length || taste.weight.length !== dims.scalar.length) {
    throw new Error(`taste: expected ${dims.scalar.length} scalar dims`);
  }
  ints(taste.target, -TARGET_SCALE, TARGET_SCALE, "target");
  ints(taste.weight, 0, WEIGHT_SCALE, "weight");
  for (const group of GROUPS) {
    const p = taste[group];
    if (p === null) continue;
    if (p.length !== dims[group].length)
      throw new Error(`taste: expected ${dims[group].length} ${group}`);
    ints(p, 0, P_SCALE, group);
    if (p.every((x) => x === 0)) throw new Error(`taste: ${group} distribution is all zero`);
  }
}
