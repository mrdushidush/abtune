// CatalogReader (HANDOFF §5.2): an installed catalog (full build, dev sample or the committed
// fixture) as the engine's typed-array columns, plus display rows for the tracks a playlist uses.
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  type CatalogColumns,
  CLUSTER_SLOTS,
  type Dimensions,
  LANG_INSTRUMENTAL,
  MARKETS,
  NONE,
  SEASONAL_TITLE,
} from "@abtune/engine";
import { type DuckDBBlobValue, DuckDBInstance } from "@duckdb/node-api";
import { NORMALIZE_MACROS } from "./build/songs.ts";
import { lit, pathLit } from "./db.ts";
import { CATALOG_SCHEMA_VERSION, type CatalogManifest } from "./manifest.ts";
import { SCALAR_COLUMNS } from "./schema.ts";

/** What a playlist row shows (and exports): display data, never used for scoring. */
export interface TrackMeta {
  readonly track_id: string;
  readonly title: string;
  readonly artist_credit: string;
  readonly release_title: string | null;
  readonly year: number | null;
  readonly isrcs: readonly string[];
  readonly language: string;
  readonly primary_cluster: string | null;
  readonly feature_source: string;
  readonly listeners: number;
  readonly popularity_pct: number;
  readonly length_ms: number | null;
}

export interface LoadedCatalog {
  readonly dir: string;
  readonly manifest: CatalogManifest;
  readonly columns: CatalogColumns;
  /** Wall time of the column load. */
  readonly loadMs: number;
  /** The MusicBrainz recording id of row `index`. */
  trackId(index: number): string;
  /** Row index of a MusicBrainz recording id, or -1 if this catalog doesn't have it. */
  indexOf(trackId: string): number;
  /** Display rows for `indices`, in the same order. */
  meta(indices: readonly number[]): Promise<TrackMeta[]>;
  /**
   * For each wanted song, the rows whose artist credit contains one of `artists` and whose
   * normalized title equals one of `titles` (case, accents, punctuation and version noise ignored).
   */
  match(wanted: readonly SongQuery[]): Promise<number[][]>;
  /** One numeric column for every row (e.g. `proxy_listeners`), in row order. */
  numbers(column: string): Promise<Float64Array>;
  close(): void;
}

export interface SongQuery {
  readonly artists: readonly string[];
  readonly titles: readonly string[];
}

/** Lowercase, accent-free letters and digits only (SQL side: `squash`). */
const SQUASH = String.raw`CREATE OR REPLACE MACRO squash(s) AS regexp_replace(lower(strip_accents(s)), '[^\p{L}\p{N}]+', '', 'g');`;

export interface LoadOptions {
  /** DuckDB threads (default: all cores). */
  readonly threads?: number;
}

/** The columns the reader needs, with types, for reading the fixture's JSON lines. */
const JSON_COLUMNS: Record<string, string> = {
  track_id: "VARCHAR",
  title: "VARCHAR",
  artist_credit: "VARCHAR",
  artist_mbids: "VARCHAR[]",
  release_title: "VARCHAR",
  year: "INTEGER",
  decade: "VARCHAR",
  isrcs: "VARCHAR[]",
  language: "VARCHAR",
  clusters: "MAP(VARCHAR, FLOAT)",
  primary_cluster: "VARCHAR",
  ...Object.fromEntries(SCALAR_COLUMNS.map((c) => [c, "FLOAT"])),
  feature_source: "VARCHAR",
  feature_confidence: "FLOAT",
  listeners: "BIGINT",
  popularity_pct: "DOUBLE",
  length_ms: "INTEGER",
  market: "VARCHAR",
  artist_rank: "INTEGER",
  hit_pct: "DOUBLE",
  tier: "INTEGER",
  proxy_listeners: "INTEGER",
};

function sourceSql(dir: string): string {
  const parquet = path.join(dir, "tracks.parquet");
  if (existsSync(parquet)) return `read_parquet(${pathLit(parquet)})`;
  const jsonl = path.join(dir, "tracks.jsonl.gz");
  if (existsSync(jsonl)) {
    const cols = Object.entries(JSON_COLUMNS)
      .map(([k, v]) => `${k}: ${lit(v)}`)
      .join(", ");
    return `read_json(${pathLit(jsonl)}, format = 'newline_delimited', columns = {${cols}})`;
  }
  throw new Error(`${dir}: no tracks.parquet or tracks.jsonl.gz`);
}

const sqlList = (keys: readonly string[]) => `[${keys.map(lit).join(", ")}]`;

/**
 * Load a catalog directory into columns aligned with `dims` (the bank's declaration order).
 * Rows are in track_id order. Fails if the catalog uses a cluster, decade, language or scalar the
 * bank doesn't declare.
 */
export async function loadCatalog(
  dir: string,
  dims: Dimensions,
  { threads }: LoadOptions = {},
): Promise<LoadedCatalog> {
  const started = performance.now();
  const manifest = JSON.parse(
    await readFile(path.join(dir, "manifest.json"), "utf8"),
  ) as CatalogManifest;
  if (manifest.schema_version !== CATALOG_SCHEMA_VERSION)
    throw new Error(
      `${dir} is catalog schema ${manifest.schema_version ?? "?"}, and this ABTune reads schema ${CATALOG_SCHEMA_VERSION}. Run \`abtune catalog fetch\` for a current catalog.`,
    );
  for (const d of dims.scalar) {
    if (!(SCALAR_COLUMNS as readonly string[]).includes(d)) {
      throw new Error(`The bank's scalar "${d}" is not a catalog column.`);
    }
  }
  const instance = await DuckDBInstance.create(
    ":memory:",
    threads ? { threads: String(threads) } : {},
  );
  const conn = await instance.connect();
  const src = sourceSql(dir);
  try {
    await conn.run(NORMALIZE_MACROS);
    const G = sqlList(dims.genres);
    const D = sqlList(dims.decades);
    const L = sqlList(dims.languages);

    const unknown = (
      await conn.runAndReadAll(`
      SELECT
        (SELECT list(DISTINCT k ORDER BY k) FROM (SELECT unnest(map_keys(clusters)) AS k FROM ${src})
           WHERE list_position(${G}, k) IS NULL) AS clusters,
        list(DISTINCT decade ORDER BY decade) FILTER (WHERE decade IS NOT NULL AND list_position(${D}, decade) IS NULL) AS decades,
        list(DISTINCT language ORDER BY language) FILTER (WHERE language NOT IN ('none', 'unknown') AND list_position(${L}, language) IS NULL) AS languages
      FROM ${src}`)
    ).getRowObjectsJS()[0] as Record<string, string[] | null>;
    for (const [what, keys] of Object.entries(unknown)) {
      if (keys && keys.length > 0) {
        throw new Error(
          `${dir}: ${what} not in the question bank's dimensions: ${keys.join(", ")}`,
        );
      }
    }

    const slots = Array.from({ length: CLUSTER_SLOTS }, (_, k) => k + 1);
    const result = await conn.stream(`
      WITH t AS (SELECT * FROM ${src}),
      art AS (SELECT a1, (dense_rank() OVER (ORDER BY a1) - 1)::INTEGER AS aid
              FROM (SELECT DISTINCT artist_mbids[1] AS a1 FROM t)),
      ttl AS (SELECT nt, (dense_rank() OVER (ORDER BY nt) - 1)::INTEGER AS tid
              FROM (SELECT DISTINCT norm_title(title) AS nt FROM t)),
      r AS (
        SELECT t.*,
          list_sort(list_transform(map_entries(t.clusters),
            e -> {w: e.value, i: -list_position(${G}, e.key)}), 'DESC') AS cs
        FROM t)
      SELECT from_hex(replace(r.track_id, '-', '')) AS id,
        ${dims.scalar.map((d) => `coalesce(r.${d}, 0)::FLOAT`).join(", ")},
        r.feature_confidence::FLOAT,
        ${slots.map((k) => `coalesce(-r.cs[${k}].i - 1, ${NONE})::UTINYINT`).join(", ")},
        ${slots.map((k) => `coalesce(r.cs[${k}].w, 0)::FLOAT`).join(", ")},
        coalesce(list_position(${G}, r.primary_cluster) - 1, ${NONE})::UTINYINT,
        coalesce(list_position(${D}, r.decade) - 1, ${NONE})::UTINYINT,
        (CASE WHEN r.language = 'none' THEN ${LANG_INSTRUMENTAL}
              ELSE coalesce(list_position(${L}, r.language) - 1, ${NONE}) END)::UTINYINT,
        art.aid, ttl.tid, coalesce(r.year, 0)::SMALLINT, r.tier::UTINYINT,
        (list_position(${sqlList(MARKETS)}, r.market) - 1)::UTINYINT, r.hit_pct::FLOAT,
        least(r.artist_rank, 255)::UTINYINT,
        regexp_matches(r.title, ${lit(SEASONAL_TITLE)}, 'i')::UTINYINT
      FROM r
      JOIN art ON art.a1 = r.artist_mbids[1]
      JOIN ttl ON ttl.nt = norm_title(r.title)
      ORDER BY r.track_id`);

    const n = manifest.tracks;
    const S = dims.scalar.length;
    const ids = new Uint8Array(n * 16);
    const scalars = dims.scalar.map(() => new Float32Array(n));
    const confidence = new Float32Array(n);
    const clusterIdx = new Uint8Array(n * CLUSTER_SLOTS);
    const clusterW = new Float32Array(n * CLUSTER_SLOTS);
    const primary = new Uint8Array(n);
    const decade = new Uint8Array(n);
    const lang = new Uint8Array(n);
    const artist = new Int32Array(n);
    const titleKey = new Int32Array(n);
    const year = new Int16Array(n);
    const tier = new Uint8Array(n);
    const market = new Uint8Array(n);
    const hit = new Float32Array(n);
    const artistRank = new Uint8Array(n);
    const seasonal = new Uint8Array(n);

    let row = 0;
    for (;;) {
      const chunk = await result.fetchChunk();
      if (!chunk || chunk.rowCount === 0) break;
      const cols = chunk.getColumns();
      const rc = chunk.rowCount;
      if (row + rc > n) throw new Error(`${dir}: more rows than the manifest's ${n}`);
      const col = (c: number) => cols[c] as unknown[];
      const idCol = col(0) as DuckDBBlobValue[];
      for (let j = 0; j < rc; j++) ids.set((idCol[j] as DuckDBBlobValue).bytes, (row + j) * 16);
      let c = 1;
      for (let d = 0; d < S; d++) (scalars[d] as Float32Array).set(col(c++) as number[], row);
      confidence.set(col(c++) as number[], row);
      for (let k = 0; k < CLUSTER_SLOTS; k++) {
        const v = col(c++) as number[];
        for (let j = 0; j < rc; j++) clusterIdx[(row + j) * CLUSTER_SLOTS + k] = v[j] as number;
      }
      for (let k = 0; k < CLUSTER_SLOTS; k++) {
        const v = col(c++) as number[];
        for (let j = 0; j < rc; j++) clusterW[(row + j) * CLUSTER_SLOTS + k] = v[j] as number;
      }
      primary.set(col(c++) as number[], row);
      decade.set(col(c++) as number[], row);
      lang.set(col(c++) as number[], row);
      artist.set(col(c++) as number[], row);
      titleKey.set(col(c++) as number[], row);
      year.set(col(c++) as number[], row);
      tier.set(col(c++) as number[], row);
      market.set(col(c++) as number[], row);
      hit.set(col(c++) as number[], row);
      artistRank.set(col(c++) as number[], row);
      seasonal.set(col(c++) as number[], row);
      row += rc;
    }
    if (row !== n) throw new Error(`${dir}: ${row} rows, but the manifest says ${n}`);

    const columns: CatalogColumns = {
      version: manifest.catalog_version,
      dimensions: dims,
      n,
      scalars,
      confidence,
      clusterIdx,
      clusterW,
      primary,
      decade,
      lang,
      artist,
      titleKey,
      year,
      tier,
      market,
      hit,
      artistRank,
      seasonal,
    };
    const trackId = (index: number): string => {
      if (!Number.isInteger(index) || index < 0 || index >= n)
        throw new Error(`bad track index ${index}`);
      const hex = Buffer.from(ids.subarray(index * 16, index * 16 + 16)).toString("hex");
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    };
    // Rows are in track_id order, and lowercase hex UUIDs sort like their bytes: binary search.
    const indexOf = (id: string): number => {
      const hex = id.toLowerCase().replaceAll("-", "");
      if (!/^[0-9a-f]{32}$/.test(hex)) return -1;
      const key = Buffer.from(hex, "hex");
      let lo = 0;
      let hi = n - 1;
      while (lo <= hi) {
        const mid = (lo + hi) >>> 1;
        const c = Buffer.compare(ids.subarray(mid * 16, mid * 16 + 16), key);
        if (c === 0) return mid;
        if (c < 0) lo = mid + 1;
        else hi = mid - 1;
      }
      return -1;
    };
    const meta = async (indices: readonly number[]): Promise<TrackMeta[]> => {
      if (indices.length === 0) return [];
      const wanted = indices.map(trackId);
      const rows = (
        await conn.runAndReadAll(`
          SELECT track_id, title, artist_credit, release_title, year, coalesce(isrcs, []) AS isrcs,
                 language, primary_cluster, feature_source, listeners, popularity_pct, length_ms
          FROM ${src} WHERE track_id IN (${wanted.map(lit).join(", ")})`)
      ).getRowObjectsJS() as unknown as (TrackMeta & { listeners: bigint | number })[];
      const byId = new Map(rows.map((r) => [r.track_id, { ...r, listeners: Number(r.listeners) }]));
      return wanted.map((id) => {
        const m = byId.get(id);
        if (!m) throw new Error(`track ${id} vanished from ${dir}`);
        return m;
      });
    };
    const match = async (wanted: readonly SongQuery[]): Promise<number[][]> => {
      const out: number[][] = wanted.map(() => []);
      const pairs = wanted.flatMap((w, k) =>
        w.artists.flatMap((a) => w.titles.map((t) => `(${k}, ${lit(a)}, ${lit(t)})`)),
      );
      if (pairs.length === 0) return out;
      await conn.run(SQUASH);
      const rows = (
        await conn.runAndReadAll(`
          WITH q AS (SELECT k, squash(a) AS a, squash(t) AS t FROM (VALUES ${pairs.join(", ")}) v(k, a, t)),
          c AS (SELECT track_id, squash(artist_credit) AS a, squash(norm_title(title)) AS t FROM ${src})
          SELECT DISTINCT q.k, c.track_id FROM q JOIN c ON c.t = q.t AND contains(c.a, q.a)
          ORDER BY q.k, c.track_id`)
      ).getRowObjectsJS() as { k: number; track_id: string }[];
      for (const r of rows) out[Number(r.k)]?.push(indexOf(r.track_id));
      return out;
    };
    const numbers = async (column: string): Promise<Float64Array> => {
      if (!/^[a-z_][a-z0-9_]*$/.test(column)) throw new Error(`bad column name ${column}`);
      const out = new Float64Array(n);
      const res = await conn.stream(
        `SELECT coalesce(${column}, 0)::DOUBLE AS v FROM ${src} ORDER BY track_id`,
      );
      let row = 0;
      for (;;) {
        const chunk = await res.fetchChunk();
        if (!chunk || chunk.rowCount === 0) break;
        out.set(chunk.getColumns()[0] as number[], row);
        row += chunk.rowCount;
      }
      return out;
    };
    return {
      dir,
      manifest,
      columns,
      loadMs: performance.now() - started,
      trackId,
      indexOf,
      meta,
      match,
      numbers,
      close() {
        conn.closeSync();
        instance.closeSync();
      },
    };
  } catch (err) {
    conn.closeSync();
    instance.closeSync();
    throw err;
  }
}
