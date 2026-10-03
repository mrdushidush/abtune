import { POPULARITY_DIM, TARGET_SCALE, type TasteVector } from "../taste.ts";
import { type CatalogColumns, MARKETS, NONE, TIER_DEEP, TIER_HITS, TIER_TAIL } from "./columns.ts";
import type { GeneratorParams } from "./params.ts";

/** The listener's popularity target t ∈ [-1, 1] ("Radio hits" +, "Hidden gems" −); 0 without evidence. */
export function popularityTarget(columns: CatalogColumns, taste: TasteVector): number {
  const d = columns.dimensions.scalar.indexOf(POPULARITY_DIM);
  return d >= 0 && (taste.weight[d] ?? 0) > 0 ? (taste.target[d] ?? 0) / TARGET_SCALE : 0;
}

/**
 * The deepest popularity tier a playlist starts from (owner decision D6, "graded by the slider"):
 * the hits view, then deep cuts by artists you know, then the whole long tail.
 */
export function tierCeiling(t: number, params: GeneratorParams): number {
  if (t >= params.hitsAbove) return TIER_HITS;
  if (t >= params.deepAbove) return TIER_DEEP;
  return TIER_TAIL;
}

/**
 * Hit rank of every track inside its familiarity group, (primary cluster, decade, market), among
 * the tracks of tier ≤ the ceiling. Rank 0 = the group's best-known track; tracks above the
 * ceiling get no rank (they are never eligible at that ceiling).
 */
export interface FamiliarityRanks {
  readonly rank: Int32Array;
  /** Size of the track's group. */
  readonly size: Int32Array;
}

const cache = new WeakMap<CatalogColumns, Map<number, FamiliarityRanks>>();

export function familiarityRanks(columns: CatalogColumns, ceiling: number): FamiliarityRanks {
  let byCeiling = cache.get(columns);
  if (!byCeiling) {
    byCeiling = new Map();
    cache.set(columns, byCeiling);
  }
  let out = byCeiling.get(ceiling);
  if (out) return out;

  const G = columns.dimensions.genres.length + 1;
  const D = columns.dimensions.decades.length + 1;
  const M = MARKETS.length;
  const n = columns.n;
  const groupOf = new Int32Array(n).fill(-1);
  const counts = new Int32Array(G * D * M);
  for (let i = 0; i < n; i++) {
    if ((columns.tier[i] as number) > ceiling) continue;
    const g = columns.primary[i] as number;
    const d = columns.decade[i] as number;
    const c =
      ((g === NONE ? G - 1 : g) * D + (d === NONE ? D - 1 : d)) * M + (columns.market[i] as number);
    groupOf[i] = c;
    counts[c] = (counts[c] as number) + 1;
  }
  // Counting sort into groups (ascending track index inside each), then sort each group.
  const starts = new Int32Array(counts.length + 1);
  for (let c = 0; c < counts.length; c++)
    starts[c + 1] = (starts[c] as number) + (counts[c] as number);
  const fill = starts.slice(0, counts.length);
  const order = new Int32Array(starts[counts.length] as number);
  for (let i = 0; i < n; i++) {
    const c = groupOf[i] as number;
    if (c < 0) continue;
    order[fill[c] as number] = i;
    fill[c] = (fill[c] as number) + 1;
  }
  const { hit, artistRank } = columns;
  const rank = new Int32Array(n).fill(-1);
  const size = new Int32Array(n);
  for (let c = 0; c < counts.length; c++) {
    const s = starts[c] as number;
    const e = starts[c + 1] as number;
    if (e === s) continue;
    const group = order.subarray(s, e);
    // Best-known first; ties by the song's rank within its artist, then track index.
    group.sort(
      (a, b) =>
        (hit[b] as number) - (hit[a] as number) ||
        (artistRank[a] as number) - (artistRank[b] as number) ||
        a - b,
    );
    for (let r = 0; r < group.length; r++) {
      rank[group[r] as number] = r;
      size[group[r] as number] = group.length;
    }
  }
  out = { rank, size };
  byCeiling.set(ceiling, out);
  return out;
}

/** Compute what generation caches per catalog (server start-up, so no request pays for it). */
export function warmFamiliarity(columns: CatalogColumns): void {
  for (const ceiling of [TIER_HITS, TIER_DEEP, TIER_TAIL]) familiarityRanks(columns, ceiling);
}

/** How a window sizes itself (see FamiliarityWindow). */
export interface WindowSize {
  /** Share of each group. */
  readonly share: number;
  /** At least this many times the cell's pool size. */
  readonly pool: number;
  /** ratio^(−t): "Radio hits" narrows the window, "Hidden gems" widens it. */
  readonly scale: number;
}

export function windowSize(t: number, params: GeneratorParams): WindowSize {
  return {
    share: params.familiarityShare,
    pool: params.familiarityPool,
    scale: params.familiarityRatio ** -t,
  };
}

/**
 * Tracks a cell may use at window `level`: each group's best-known
 * max(min, ⌈max(pool·min, share·size) · scale⌉) · 2^level. `min` is the cell's pool size, so
 * every market in a cell offers a full pool of its own best-known tracks and the language score,
 * not the catalog's language mix, decides between them; `pool` > 1 leaves the score (and so the
 * tweaks) a choice among that many times more well-known tracks.
 */
export class FamiliarityWindow {
  private readonly ranks: FamiliarityRanks;
  private readonly size: WindowSize;
  /** From this level on, every window holds its whole group. */
  readonly fullLevel: number;

  constructor(ranks: FamiliarityRanks, size: WindowSize) {
    this.ranks = ranks;
    this.size = size;
    let biggest = 1;
    for (const s of ranks.size) if (s > biggest) biggest = s;
    this.fullLevel = Math.ceil(Math.log2(biggest));
  }

  has(track: number, level: number, min: number): boolean {
    const rank = this.ranks.rank[track] as number;
    if (rank < 0) return false;
    if (level >= this.fullLevel) return true;
    const { share, pool, scale } = this.size;
    const group = this.ranks.size[track] as number;
    const base = Math.max(pool * min, share * group);
    const limit = Math.max(min, Math.ceil(base * scale)) * 2 ** level;
    return rank < limit;
  }
}
