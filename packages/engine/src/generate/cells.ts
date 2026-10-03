import type { TasteVector } from "../taste.ts";
import { type CatalogColumns, NONE, TIER_TAIL } from "./columns.ts";
import type { GeneratorParams } from "./params.ts";

/**
 * Which tracks may enter a playlist. Flags are indexed by genre / decade index, plus one extra
 * entry at the end for "no cluster" / "unknown decade".
 */
export interface Eligibility {
  readonly genres: Uint8Array;
  readonly decades: Uint8Array;
  /** Language index every track must have, or -1 for any language. */
  readonly language: number;
  /** Per language index: 1 = left out (params.avoidLanguages). */
  readonly avoid: Uint8Array;
  /** Deepest popularity tier allowed (TIER_HITS … TIER_TAIL). */
  readonly maxTier: number;
}

/** A (primary cluster, decade) cell with at least one eligible track (HANDOFF §9.2). */
export interface Cell {
  /** genre bucket × (decades + 1) + decade bucket; buckets put NONE last. */
  readonly id: number;
  /** Genre / decade index, or NONE. */
  readonly genre: number;
  readonly decade: number;
  /** p_genre · p_decade, normalized over non-empty cells. */
  readonly weight: number;
  /** Eligible tracks. Members are `plan.members[start .. start + size)`, ascending track index. */
  readonly size: number;
  readonly start: number;
  /** Inside the cumulative-mass cut (§9.2.2). Other cells only take overflow. */
  readonly kept: boolean;
}

export interface CellPlan {
  /** Non-empty cells, heaviest first (ties: id). */
  readonly cells: readonly Cell[];
  readonly members: Int32Array;
}

interface Natural {
  /** Catalog share of each primary cluster (last entry: no cluster). */
  readonly genre: Float64Array;
  readonly decade: Float64Array;
}
const naturalCache = new WeakMap<CatalogColumns, Natural>();

/** The catalog's own (primary cluster, decade) distribution, used for groups without a preference. */
export function naturalShares(columns: CatalogColumns): Natural {
  let natural = naturalCache.get(columns);
  if (!natural) {
    const G = columns.dimensions.genres.length;
    const D = columns.dimensions.decades.length;
    const genre = new Float64Array(G + 1);
    const decade = new Float64Array(D + 1);
    for (let i = 0; i < columns.n; i++) {
      const g = columns.primary[i] as number;
      const d = columns.decade[i] as number;
      genre[g === NONE ? G : g] = (genre[g === NONE ? G : g] as number) + 1;
      decade[d === NONE ? D : d] = (decade[d === NONE ? D : d] as number) + 1;
    }
    for (let g = 0; g <= G; g++) genre[g] = (genre[g] as number) / Math.max(1, columns.n);
    for (let d = 0; d <= D; d++) decade[d] = (decade[d] as number) / Math.max(1, columns.n);
    natural = { genre, decade };
    naturalCache.set(columns, natural);
  }
  return natural;
}

/** Flags for the smallest set of keys, by p descending (ties: index), covering `mass` of the total. */
export function coverMass(p: readonly number[], mass: number): Uint8Array {
  const flags = new Uint8Array(p.length + 1);
  const total = p.reduce((a, b) => a + b, 0);
  const order = p.map((_, i) => i).sort((a, b) => (p[b] as number) - (p[a] as number) || a - b);
  let cum = 0;
  for (const i of order) {
    if ((p[i] as number) <= 0) break;
    flags[i] = 1;
    cum += p[i] as number;
    if (cum >= mass * total) break;
  }
  return flags;
}

/**
 * relax 0: §9.2.1 prefilter plus the language hard filter. relax 1: language filter only.
 * relax 2: everything (used only when the stricter sets can't fill the playlist). Only tracks of
 * tier ≤ `maxTier` are eligible.
 */
export function eligibility(
  columns: CatalogColumns,
  taste: TasteVector,
  params: GeneratorParams,
  relax: 0 | 1 | 2,
  maxTier: number = TIER_TAIL,
): Eligibility {
  const { genres, decades, languages } = columns.dimensions;
  const all = (k: number) => new Uint8Array(k + 1).fill(1);
  let language = -1;
  const avoid = new Uint8Array(languages.length);
  if (relax < 2) {
    const p = taste.languages;
    if (p) {
      const total = p.reduce((a, b) => a + b, 0);
      p.forEach((x, i) => {
        if (x >= params.languageHardFilter * total) language = i;
      });
    }
    const top = p ? Math.max(...p) : 0;
    for (const key of params.avoidLanguages) {
      const i = languages.indexOf(key);
      if (i < 0) continue;
      const x = p ? (p[i] as number) : 0;
      if (!p || (x < top && x * params.avoidRatio <= top)) avoid[i] = 1;
    }
  }
  return {
    genres:
      relax === 0 && taste.genres
        ? coverMass(taste.genres, params.prefilterMass)
        : all(genres.length),
    decades:
      relax === 0 && taste.decades
        ? coverMass(taste.decades, params.prefilterMass)
        : all(decades.length),
    language,
    avoid,
    maxTier,
  };
}

/** Group shares for cell weights: the listener's distribution, or the catalog's when there is none. */
function shares(p: readonly number[] | null, natural: Float64Array): Float64Array {
  if (!p) return natural;
  const total = p.reduce((a, b) => a + b, 0);
  const out = new Float64Array(p.length + 1);
  p.forEach((x, i) => {
    out[i] = x / total;
  });
  return out; // the last bucket (no cluster / unknown decade) gets 0
}

/** Group eligible tracks into cells, weight them and mark the §9.2.2 cut. */
export function planCells(
  columns: CatalogColumns,
  taste: TasteVector,
  params: GeneratorParams,
  elig: Eligibility,
): CellPlan {
  const G = columns.dimensions.genres.length;
  const D = columns.dimensions.decades.length;
  const nCells = (G + 1) * (D + 1);
  const cellOf = new Int16Array(columns.n);
  const counts = new Int32Array(nCells);
  const { primary, decade, lang, tier, seasonal } = columns;
  for (let i = 0; i < columns.n; i++) {
    const g = primary[i] as number;
    const d = decade[i] as number;
    const gb = g === NONE ? G : g;
    const db = d === NONE ? D : d;
    if (
      (tier[i] as number) <= elig.maxTier &&
      seasonal[i] === 0 &&
      elig.avoid[lang[i] as number] !== 1 &&
      elig.genres[gb] === 1 &&
      elig.decades[db] === 1 &&
      (elig.language < 0 || lang[i] === elig.language)
    ) {
      const c = gb * (D + 1) + db;
      cellOf[i] = c;
      counts[c] = (counts[c] as number) + 1;
    } else {
      cellOf[i] = -1;
    }
  }

  const natural = naturalShares(columns);
  const pg = shares(taste.genres, natural.genre);
  const pe = shares(taste.decades, natural.decade);
  const raw: { id: number; w: number }[] = [];
  for (let c = 0; c < nCells; c++) {
    if ((counts[c] as number) === 0) continue;
    const gb = Math.floor(c / (D + 1));
    raw.push({ id: c, w: (pg[gb] as number) * (pe[c % (D + 1)] as number) });
  }
  let total = raw.reduce((a, x) => a + x.w, 0);
  if (total <= 0) {
    // Only zero-weight buckets are left (relaxed plans): fall back to cell sizes.
    for (const x of raw) x.w = counts[x.id] as number;
    total = raw.reduce((a, x) => a + x.w, 0);
  }
  raw.sort((a, b) => b.w - a.w || a.id - b.id);

  const offsets = new Int32Array(nCells);
  const cells: Cell[] = [];
  let start = 0;
  let cum = 0;
  for (const { id, w } of raw) {
    const gb = Math.floor(id / (D + 1));
    const db = id % (D + 1);
    const weight = w / total;
    const kept = cells.length === 0 || cum < params.cellMass;
    cum += weight;
    const size = counts[id] as number;
    cells.push({
      id,
      genre: gb === G ? NONE : gb,
      decade: db === D ? NONE : db,
      weight,
      size,
      start,
      kept,
    });
    offsets[id] = start;
    start += size;
  }
  const members = new Int32Array(start);
  for (let i = 0; i < columns.n; i++) {
    const c = cellOf[i] as number;
    if (c < 0) continue;
    members[offsets[c] as number] = i;
    offsets[c] = (offsets[c] as number) + 1;
  }
  return { cells, members };
}

/**
 * Largest-remainder split of `total` slots by weight (ties: list order). Zero total weight
 * splits evenly.
 */
export function largestRemainder(weights: readonly number[], total: number): number[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  const w = sum > 0 ? weights : weights.map(() => 1);
  const wsum = sum > 0 ? sum : w.length;
  const exact = w.map((x) => (x / wsum) * total);
  const out = exact.map((x) => Math.floor(x));
  let left = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (left <= 0) break;
    out[i] = (out[i] as number) + 1;
    left--;
  }
  return out;
}
