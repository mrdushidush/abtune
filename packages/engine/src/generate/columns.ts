import type { Dimensions } from "../types.ts";

/** Index value meaning "no cluster", "no decade" or "unknown language". */
export const NONE = 255;
/** Language code for instrumental tracks (catalog `none`): language-neutral, like unknown. */
export const LANG_INSTRUMENTAL = 254;
/** Clusters stored per track (the catalog keeps the top 4). */
export const CLUSTER_SLOTS = 4;

/**
 * The catalog as typed arrays, one entry per track, in track_id order (HANDOFF §5.2 CatalogReader).
 * Categorical columns hold indices into `dimensions` (bank declaration order).
 */
export interface CatalogColumns {
  readonly version: string;
  readonly dimensions: Dimensions;
  readonly n: number;
  /** One array per `dimensions.scalar` key, values in [-1, 1]. */
  readonly scalars: readonly Float32Array[];
  /** feature_confidence in [0, 1]. */
  readonly confidence: Float32Array;
  /** Track i's clusters at [i·4, i·4+4): genre index (NONE = empty slot), heaviest first. */
  readonly clusterIdx: Uint8Array;
  readonly clusterW: Float32Array;
  /** Primary cluster (NONE = no cluster). */
  readonly primary: Uint8Array;
  /** Decade (NONE = unknown year). */
  readonly decade: Uint8Array;
  /** Language (NONE = unknown, LANG_INSTRUMENTAL = no lyrics). */
  readonly lang: Uint8Array;
  /** First credited artist, as a dense id. */
  readonly artist: Int32Array;
  /** Normalized title, as a dense id (same id = same song title for §9.3). */
  readonly titleKey: Int32Array;
  /** First release year, 0 = unknown. */
  readonly year: Int16Array;
}

/** One track as plain data, for building columns in tests and small tools. */
export interface ColumnRow {
  /** Keyed by scalar dim; missing = 0. */
  readonly scalars: Readonly<Record<string, number>>;
  readonly confidence: number;
  readonly clusters: Readonly<Record<string, number>>;
  readonly primary: string | null;
  readonly decade: string | null;
  /** A `dimensions.languages` key, `none` (instrumental) or anything else (unknown). */
  readonly language: string;
  readonly artist: number;
  readonly titleKey: number;
  readonly year: number | null;
}

function indexOf(keys: readonly string[], key: string | null, what: string): number {
  if (key === null) return NONE;
  const i = keys.indexOf(key);
  if (i < 0) throw new Error(`Unknown ${what} "${key}"`);
  return i;
}

export function languageCode(dims: Dimensions, language: string): number {
  const i = dims.languages.indexOf(language);
  return i >= 0 ? i : language === "none" ? LANG_INSTRUMENTAL : NONE;
}

export function buildColumns(
  dimensions: Dimensions,
  version: string,
  rows: readonly ColumnRow[],
): CatalogColumns {
  const n = rows.length;
  const scalars = dimensions.scalar.map(() => new Float32Array(n));
  const cols = {
    confidence: new Float32Array(n),
    clusterIdx: new Uint8Array(n * CLUSTER_SLOTS).fill(NONE),
    clusterW: new Float32Array(n * CLUSTER_SLOTS),
    primary: new Uint8Array(n),
    decade: new Uint8Array(n),
    lang: new Uint8Array(n),
    artist: new Int32Array(n),
    titleKey: new Int32Array(n),
    year: new Int16Array(n),
  };
  rows.forEach((row, i) => {
    dimensions.scalar.forEach((dim, d) => {
      (scalars[d] as Float32Array)[i] = row.scalars[dim] ?? 0;
    });
    cols.confidence[i] = row.confidence;
    const clusters = Object.entries(row.clusters)
      .map(([key, w]) => ({ c: indexOf(dimensions.genres, key, "cluster"), w }))
      .sort((a, b) => b.w - a.w || a.c - b.c)
      .slice(0, CLUSTER_SLOTS);
    clusters.forEach(({ c, w }, k) => {
      cols.clusterIdx[i * CLUSTER_SLOTS + k] = c;
      cols.clusterW[i * CLUSTER_SLOTS + k] = w;
    });
    cols.primary[i] = indexOf(dimensions.genres, row.primary, "cluster");
    cols.decade[i] = indexOf(dimensions.decades, row.decade, "decade");
    cols.lang[i] = languageCode(dimensions, row.language);
    cols.artist[i] = row.artist;
    cols.titleKey[i] = row.titleKey;
    cols.year[i] = row.year ?? 0;
  });
  return { version, dimensions, n, scalars, ...cols };
}
