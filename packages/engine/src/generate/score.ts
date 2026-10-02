import { TARGET_SCALE, type TasteVector, WEIGHT_SCALE } from "../taste.ts";
import { type CatalogColumns, CLUSTER_SLOTS, NONE } from "./columns.ts";
import type { GeneratorParams } from "./params.ts";

/** Scores are quantized to integers in [0, SCORE_SCALE] before any sort or sample (ADR-0001). */
export const SCORE_SCALE = 1 << 20;

/** Per-request constants for scoring, derived once from the taste vector. */
export interface Scorer {
  readonly columns: CatalogColumns;
  /** Scalar dims with weight > 0: their columns, targets and κ. */
  readonly dims: readonly { col: Float32Array; target: number; kappa: number }[];
  readonly kappaSum: number;
  /** Normalized p / max p per group, or null (group ignored). */
  readonly genre: Float64Array | null;
  readonly decade: Float64Array | null;
  readonly language: Float64Array | null;
  readonly languageNeutral: number;
  readonly w: { readonly s: number; readonly g: number; readonly e: number; readonly l: number };
}

function relative(p: readonly number[] | null): Float64Array | null {
  if (!p) return null;
  let max = 0;
  for (const x of p) if (x > max) max = x;
  if (max <= 0) return null;
  return Float64Array.from(p, (x) => x / max);
}

export function createScorer(
  columns: CatalogColumns,
  taste: TasteVector,
  params: GeneratorParams,
): Scorer {
  const dims: { col: Float32Array; target: number; kappa: number }[] = [];
  let kappaSum = 0;
  taste.weight.forEach((wq, d) => {
    if (wq <= 0) return;
    const kappa = wq / WEIGHT_SCALE;
    dims.push({
      col: columns.scalars[d] as Float32Array,
      target: (taste.target[d] ?? 0) / TARGET_SCALE,
      kappa,
    });
    kappaSum += kappa;
  });
  const genre = relative(taste.genres);
  const decade = relative(taste.decades);
  const language = relative(taste.languages);
  // A component without evidence drops out; the others are renormalized (§7.3 "no preference").
  const ws = kappaSum > 0 ? params.wScalar : 0;
  const wg = genre ? params.wGenre : 0;
  const we = decade ? params.wDecade : 0;
  const wl = language ? params.wLanguage : 0;
  const sum = ws + wg + we + wl;
  const w =
    sum > 0 ? { s: ws / sum, g: wg / sum, e: we / sum, l: wl / sum } : { s: 0, g: 0, e: 0, l: 0 };
  return {
    columns,
    dims,
    kappaSum,
    genre,
    decade,
    language,
    languageNeutral: params.languageNeutral,
    w,
  };
}

/**
 * HANDOFF §9.1 for one track, in [0, 1]:
 *   S = Σ κ_d (1 − |t_d − f_d|/2) · q / Σ κ_d     G = Σ_c p_c·w_c / max p
 *   E = p_decade / max p                          L = p_lang / max p (neutral if unknown)
 * Only additions and multiplications over the same inputs in a fixed order: bit-reproducible.
 */
export function scoreTrack(s: Scorer, i: number): number {
  const c = s.columns;
  let total = 0;
  if (s.w.s > 0) {
    let acc = 0;
    for (const d of s.dims) acc += d.kappa * (1 - Math.abs(d.target - (d.col[i] as number)) / 2);
    total += s.w.s * (acc / s.kappaSum) * (c.confidence[i] as number);
  }
  if (s.genre) {
    let g = 0;
    for (let k = 0; k < CLUSTER_SLOTS; k++) {
      const idx = c.clusterIdx[i * CLUSTER_SLOTS + k] as number;
      if (idx === NONE) break;
      g += (s.genre[idx] as number) * (c.clusterW[i * CLUSTER_SLOTS + k] as number);
    }
    total += s.w.g * g;
  }
  if (s.decade) {
    const d = c.decade[i] as number;
    if (d !== NONE) total += s.w.e * (s.decade[d] as number);
  }
  if (s.language) {
    const l = c.lang[i] as number;
    total += s.w.l * (l < s.language.length ? (s.language[l] as number) : s.languageNeutral);
  }
  return total;
}

/** Quantized scores of `indices` into `out` (same positions). */
export function scoreMany(s: Scorer, indices: Int32Array, out: Int32Array): void {
  for (let j = 0; j < indices.length; j++) {
    out[j] = Math.round(scoreTrack(s, indices[j] as number) * SCORE_SCALE);
  }
}
