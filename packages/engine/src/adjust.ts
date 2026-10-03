import {
  P_SCALE,
  quantizeDistribution,
  TARGET_SCALE,
  type TasteVector,
  validateTaste,
} from "./taste.ts";
import type { Dimensions } from "./types.ts";

/**
 * AI adjustments (HANDOFF §10.2 T1 Interpret, T3 Tweak): bounded nudges to a taste vector. Like
 * tweaks, the result is again a TasteVector, so a share link carries the outcome and reproduces the
 * playlist with the AI layer off (§9.5). Values are integers × ADJUST_SCALE, keyed by dimension.
 * Languages are never adjusted.
 */
export interface TasteAdjust {
  /** Scalar dim → target shift, within ±MAX_SCALAR_DELTA. */
  readonly scalar: Readonly<Record<string, number>>;
  /** Genre → boost, within ±MAX_GROUP_BOOST. */
  readonly genres: Readonly<Record<string, number>>;
  /** Decade → boost, within ±MAX_GROUP_BOOST. */
  readonly decades: Readonly<Record<string, number>>;
}

export const ADJUST_SCALE = 100;
/** §10.2: scalar_deltas in [-0.3, 0.3]. */
export const MAX_SCALAR_DELTA = 30;
/** §10.2: genre_boosts and decade_boosts in [-0.5, 0.5]. */
export const MAX_GROUP_BOOST = 50;

export const ADJUST_KINDS = ["scalar", "genres", "decades"] as const;
export type AdjustKind = (typeof ADJUST_KINDS)[number];

/** The AI's view counts for about two answers on a dim it shifts: κ is raised to this (of 100). */
export const AI_MIN_WEIGHT = 40;
/**
 * A boost b multiplies a category's share by 1 + GAIN·b (b > 0) or divides it by 1 − GAIN·b
 * (b < 0): ±0.5 is ×2.5 or ÷2.5. Plain arithmetic, no Math.exp, so every JS engine agrees.
 */
export const GROUP_GAIN = 3;
/** A boosted category starts from at least this share (of P_SCALE), so a boost can add a genre. */
export const GROUP_FLOOR = 20;

export const EMPTY_ADJUST: TasteAdjust = { scalar: {}, genres: {}, decades: {} };

const keysOf = (dims: Dimensions, kind: AdjustKind): readonly string[] =>
  kind === "scalar" ? dims.scalar : dims[kind];
const limitOf = (kind: AdjustKind) => (kind === "scalar" ? MAX_SCALAR_DELTA : MAX_GROUP_BOOST);

export function isEmptyAdjust(adj: TasteAdjust): boolean {
  return ADJUST_KINDS.every((k) => Object.values(adj[k]).every((v) => v === 0));
}

/** Throws unless every key is a known dimension of its kind and every value an integer in range. */
export function validateAdjust(dims: Dimensions, adj: TasteAdjust): void {
  for (const kind of ADJUST_KINDS) {
    const keys = keysOf(dims, kind);
    const limit = limitOf(kind);
    const map = adj[kind];
    if (typeof map !== "object" || map === null) throw new Error(`adjust: bad ${kind}`);
    for (const [key, v] of Object.entries(map)) {
      if (!keys.includes(key)) throw new Error(`adjust: unknown ${kind} key ${key}`);
      if (!Number.isInteger(v) || Math.abs(v) > limit)
        throw new Error(`adjust: bad ${kind} value ${String(v)} for ${key}`);
    }
  }
}

/**
 * Model output (floats in the §10.2 units) → a valid adjustment: unknown keys dropped, values
 * clamped and quantized, zeros dropped, keys in declaration order. Never throws.
 */
export function clampAdjust(
  dims: Dimensions,
  raw: Partial<Record<AdjustKind, Readonly<Record<string, number>>>>,
): TasteAdjust {
  const out = { scalar: {}, genres: {}, decades: {} } as Record<AdjustKind, Record<string, number>>;
  for (const kind of ADJUST_KINDS) {
    const limit = limitOf(kind);
    const src = raw[kind] ?? {};
    for (const key of keysOf(dims, kind)) {
      const v = src[key];
      if (typeof v !== "number" || !Number.isFinite(v)) continue;
      const q = Math.round(Math.max(-limit, Math.min(limit, v * ADJUST_SCALE)));
      if (q !== 0) out[kind][key] = q;
    }
  }
  return out;
}

function boostGroup(
  keys: readonly string[],
  p: readonly number[] | null,
  boosts: Readonly<Record<string, number>>,
): readonly number[] | null {
  if (!keys.some((k) => (boosts[k] ?? 0) !== 0)) return p;
  const base = p ?? keys.map(() => 1);
  const total = base.reduce((a, b) => a + b, 0);
  const floor = (GROUP_FLOOR / P_SCALE) * total;
  const next = keys.map((k, i) => {
    const b = (boosts[k] ?? 0) / ADJUST_SCALE;
    const x = base[i] ?? 0;
    if (b > 0) return Math.max(x, floor) * (1 + GROUP_GAIN * b);
    if (b < 0) return x / (1 - GROUP_GAIN * b);
    return x;
  });
  return quantizeDistribution(next);
}

/** Apply an adjustment to a taste vector. Pure; an empty adjustment returns an equal vector. */
export function applyAdjust(dims: Dimensions, taste: TasteVector, adj: TasteAdjust): TasteVector {
  validateAdjust(dims, adj);
  const target = [...taste.target];
  const weight = [...taste.weight];
  dims.scalar.forEach((dim, d) => {
    const delta = adj.scalar[dim] ?? 0;
    if (delta === 0) return;
    const shift = (delta / ADJUST_SCALE) * TARGET_SCALE;
    const t = Math.round(Math.max(-TARGET_SCALE, Math.min(TARGET_SCALE, (target[d] ?? 0) + shift)));
    target[d] = t === 0 ? 0 : t;
    weight[d] = Math.max(weight[d] ?? 0, AI_MIN_WEIGHT);
  });
  const out: TasteVector = {
    ...taste,
    target,
    weight,
    genres: boostGroup(dims.genres, taste.genres, adj.genres),
    decades: boostGroup(dims.decades, taste.decades, adj.decades),
  };
  validateTaste(dims, out);
  return out;
}

/** The playlist's base taste: the card taste with the free-text adjustment (T3), if any. */
export function playlistBase(
  dims: Dimensions,
  taste: TasteVector,
  adjust: TasteAdjust | null | undefined,
): TasteVector {
  return adjust && !isEmptyAdjust(adjust) ? applyAdjust(dims, taste, adjust) : taste;
}
