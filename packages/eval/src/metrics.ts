import { type CatalogColumns, CLUSTER_SLOTS, LANG_INSTRUMENTAL, NONE } from "@abtune/engine";
import type { Persona } from "./persona.ts";

/** Persona fit of one track and its parts, each in [0, 1] (HANDOFF §17). */
export interface TrackFit {
  /** Share of the track's cluster weight in target clusters (weighted by the persona). */
  readonly cluster: number;
  /** The persona's weight for the track's decade (1 if the persona has no decade targets). */
  readonly decade: number;
  /** Same for language (`none` = instrumental). */
  readonly language: number;
  /** Share of the persona's scalar ranges the track falls in (1 if it has none). */
  readonly scalar: number;
  /** cluster × decade × language × scalar */
  readonly fit: number;
}

/** Per-persona lookup tables over column indices, built once. */
export interface FitTables {
  readonly cluster: Float64Array;
  readonly decade: Float64Array | null;
  readonly language: Float64Array | null;
  readonly ranges: readonly { col: Float32Array; lo: number; hi: number }[];
}

export function fitTables(columns: CatalogColumns, persona: Persona): FitTables {
  const dims = columns.dimensions;
  const table = (keys: readonly string[], w: Readonly<Record<string, number>>) =>
    Float64Array.from(keys, (k) => w[k] ?? 0);
  let language: Float64Array | null = null;
  if (persona.languages) {
    // 256 entries so NONE / LANG_INSTRUMENTAL index directly.
    language = new Float64Array(256);
    language.set(table(dims.languages, persona.languages));
    language[LANG_INSTRUMENTAL] = persona.languages.none ?? 0;
  }
  return {
    cluster: table(dims.genres, persona.clusters),
    decade: persona.decades ? table(dims.decades, persona.decades) : null,
    language,
    ranges: Object.entries(persona.scalars).map(([dim, [lo, hi]]) => ({
      col: columns.scalars[dims.scalar.indexOf(dim)] as Float32Array,
      lo,
      hi,
    })),
  };
}

export function trackFit(columns: CatalogColumns, t: FitTables, i: number): TrackFit {
  let cluster = 0;
  for (let k = 0; k < CLUSTER_SLOTS; k++) {
    const c = columns.clusterIdx[i * CLUSTER_SLOTS + k] as number;
    if (c === NONE) break;
    cluster += (t.cluster[c] as number) * (columns.clusterW[i * CLUSTER_SLOTS + k] as number);
  }
  const d = columns.decade[i] as number;
  const decade = t.decade ? (d === NONE ? 0 : (t.decade[d] as number)) : 1;
  const language = t.language ? (t.language[columns.lang[i] as number] as number) : 1;
  let inRange = 0;
  for (const r of t.ranges) {
    const v = r.col[i] as number;
    if (v >= r.lo && v <= r.hi) inRange++;
  }
  const scalar = t.ranges.length > 0 ? inRange / t.ranges.length : 1;
  return { cluster, decade, language, scalar, fit: cluster * decade * language * scalar };
}

export interface PlaylistMetrics extends TrackFit {
  /** Mean pairwise feature distance (L1 over scalars / max), in [0, 1]. */
  readonly diversity: number;
  /** Distinct artists / tracks. */
  readonly artistSpread: number;
  /** Median catalog popularity percentile of the tracks (mainstream mapped to [0, 1]). */
  readonly popularity: number;
  /** Mean release year of dated tracks (0 if none). */
  readonly year: number;
}

const mean = (xs: readonly number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function playlistMetrics(
  columns: CatalogColumns,
  tables: FitTables,
  tracks: readonly number[],
): PlaylistMetrics {
  const fits = tracks.map((i) => trackFit(columns, tables, i));
  let pairs = 0;
  let dist = 0;
  for (let a = 0; a < tracks.length; a++) {
    for (let b = a + 1; b < tracks.length; b++) {
      let l1 = 0;
      for (const col of columns.scalars) {
        l1 += Math.abs((col[tracks[a] as number] as number) - (col[tracks[b] as number] as number));
      }
      dist += l1 / (2 * columns.scalars.length);
      pairs++;
    }
  }
  const mi = columns.dimensions.scalar.indexOf("mainstream");
  const pops = tracks
    .map((i) => (mi >= 0 ? ((columns.scalars[mi]?.[i] ?? 0) + 1) / 2 : 0))
    .sort((a, b) => a - b);
  const years = tracks.map((i) => columns.year[i] as number).filter((y) => y > 0);
  return {
    cluster: mean(fits.map((f) => f.cluster)),
    decade: mean(fits.map((f) => f.decade)),
    language: mean(fits.map((f) => f.language)),
    scalar: mean(fits.map((f) => f.scalar)),
    fit: mean(fits.map((f) => f.fit)),
    diversity: pairs > 0 ? dist / pairs : 0,
    artistSpread: tracks.length
      ? new Set(tracks.map((i) => columns.artist[i])).size / tracks.length
      : 0,
    popularity: pops.length ? (pops[Math.floor(pops.length / 2)] as number) : 0,
    year: mean(years),
  };
}

/** Expected fit of a uniformly random catalog track: the floor a playlist should beat. */
export function catalogBaseline(columns: CatalogColumns, tables: FitTables): number {
  let sum = 0;
  for (let i = 0; i < columns.n; i++) sum += trackFit(columns, tables, i).fit;
  return columns.n > 0 ? sum / columns.n : 0;
}
