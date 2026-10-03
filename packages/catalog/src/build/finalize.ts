// Stages 10–11: merge feature tiers, scale, assemble the catalog rows, export Parquet.
import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { type Db, lit, pathLit } from "../db.ts";
import { AB_DIMS } from "./features.ts";

/** feature_confidence constants (HANDOFF §6.3/§9.1); logged in docs/DECISIONS.md. */
export const CONFIDENCE = {
  abDirectBase: 0.75,
  abDirectCertainty: 0.25,
  abSiblingFactor: 0.8,
  modelWithArtist: 0.6,
  modelWithoutArtist: 0.45,
} as const;

/**
 * Scalars that are quantile-scaled to [-1, 1] over the final catalog. `mainstream` is instead the
 * hit key's percentile within the song's market (stage "hits").
 */
export const SCALED_DIMS = [...AB_DIMS, "complexity"] as const;

/** Average rank of x among n rows (ties share their mean rank) mapped into (-1, 1). */
function quantile(col: string): string {
  return `round(2 * ((rank() OVER (ORDER BY ${col}) + (count(*) OVER (PARTITION BY ${col}) - 1) / 2.0) - 0.5)
                / count(*) OVER () - 1, 4)::FLOAT`;
}

export async function buildCatalogTable(db: Db, version: string): Promise<void> {
  const tier = (d: string) => `coalesce(t1.${d}, t2.${d}, m.${d})`;
  await db.run(`
    CREATE OR REPLACE TABLE sel_raw AS
      SELECT s.song,
        CASE WHEN t1.song IS NOT NULL THEN 'ab_direct' WHEN t2.song IS NOT NULL THEN 'ab_sibling' ELSE 'model' END AS feature_source,
        ${AB_DIMS.filter((d) => d !== "intensity" && d !== "tempo")
          .map((d) => `${tier(d)} AS raw_${d}`)
          .join(", ")},
        coalesce(t1.tempo, t2.tempo, m.tempo, 0) AS raw_tempo,
        greatest(-1, least(1, ${tier("intensity")} + 0.5 * coalesce(ni.tag_mean, 0) + coalesce(ni.prior, 0))) AS raw_intensity,
        CASE WHEN nc.tag_mean IS NULL THEN coalesce(nc.prior, 0)
             ELSE 0.5 * nc.tag_mean + 0.5 * coalesce(nc.prior, 0) END::DOUBLE AS raw_complexity,
        coalesce(t1.bpm, t2.bpm) AS raw_bpm,
        CASE WHEN t1.song IS NOT NULL THEN ${CONFIDENCE.abDirectBase} + ${CONFIDENCE.abDirectCertainty} * t1.certainty
             WHEN t2.song IS NOT NULL THEN ${CONFIDENCE.abSiblingFactor} * (${CONFIDENCE.abDirectBase} + ${CONFIDENCE.abDirectCertainty} * t2.certainty)
             WHEN m.model_has_artist > 0 THEN ${CONFIDENCE.modelWithArtist}
             ELSE ${CONFIDENCE.modelWithoutArtist} END AS confidence
      FROM sel s
      LEFT JOIN dims_t1 t1 USING (song)
      LEFT JOIN dims_t2 t2 USING (song)
      LEFT JOIN dims_model m USING (song)
      LEFT JOIN cand_nudge ni ON ni.song = s.song AND ni.dim = 'intensity'
      LEFT JOIN cand_nudge nc ON nc.song = s.song AND nc.dim = 'complexity';

    -- Clusters in declaration order. list_sort per row, not an ordered aggregate: much faster.
    CREATE OR REPLACE TABLE sel_clusters AS
      SELECT cc.song,
             map_from_entries(list_transform(list_sort(list({'o': d.ord, 'k': cc.cluster, 'v': cc.w})),
                                             lambda e: (e.k, e.v))) AS clusters
      FROM cand_cluster cc JOIN dim_cluster d USING (cluster)
      WHERE cc.song IN (SELECT song FROM sel)
      GROUP BY cc.song;

    -- Window functions over a narrow numeric table: sorting the wide rows (lists, maps) ten times
    -- was the slowest part of the build.
    CREATE OR REPLACE TABLE sel_scaled AS
      SELECT song,
             ${SCALED_DIMS.map((d) => `${quantile(`raw_${d}`)} AS ${d}`).join(",\n             ")}
      FROM (
        SELECT s.song, ${SCALED_DIMS.map((d) => `r.raw_${d}`).join(", ")}
        FROM sel s JOIN sel_raw r USING (song)
      );

    CREATE OR REPLACE TABLE catalog AS
      SELECT s.gid::VARCHAR AS track_id, s.title, s.artist_credit, s.artist_mbids, s.release_title,
             s.year::SMALLINT AS year, s.decade, s.isrcs, s.language,
             coalesce(sc.clusters, MAP {}::MAP(VARCHAR, FLOAT)) AS clusters, g.primary_cluster,
             ${SCALED_DIMS.map((d) => `q.${d}`).join(", ")},
             round(2 * h.popularity_pct - 1, 4)::FLOAT AS mainstream,
             r.feature_source, round(r.confidence, 3)::FLOAT AS feature_confidence,
             s.listeners, s.listens, h.popularity_pct,
             ${lit(version)} AS catalog_version,
             s.artist_country, s.language_iso, s.length_ms, s.version_type, g.genre_source,
             ${SCALED_DIMS.map((d) => `round(r.raw_${d}, 4)::FLOAT AS raw_${d}`).join(", ")},
             round(r.raw_bpm, 1)::FLOAT AS raw_bpm, s.via AS selected_via,
             h.proxy_listeners::INTEGER AS proxy_listeners, h.release_groups::INTEGER AS release_groups,
             h.comps::INTEGER AS comps, h.va_comps::INTEGER AS va_comps, h.market, h.artist_rank,
             h.hit_pct, h.tier
      FROM sel s
      JOIN sel_raw r USING (song)
      JOIN sel_scaled q USING (song)
      JOIN sel_hits h USING (song)
      JOIN cand_genre g USING (song)
      LEFT JOIN sel_clusters sc USING (song);
  `);
}

/** Column order of tracks.parquet: the §6.5 schema first, then extras. */
export const CATALOG_COLUMNS = [
  "track_id",
  "title",
  "artist_credit",
  "artist_mbids",
  "release_title",
  "year",
  "decade",
  "isrcs",
  "language",
  "clusters",
  "primary_cluster",
  "energy",
  "valence",
  "dance",
  "acoustic",
  "intensity",
  "tempo",
  "mainstream",
  "vocal",
  "complexity",
  "feature_source",
  "feature_confidence",
  "listeners",
  "listens",
  "popularity_pct",
  "catalog_version",
  "artist_country",
  "language_iso",
  "length_ms",
  "version_type",
  "genre_source",
  "raw_energy",
  "raw_valence",
  "raw_dance",
  "raw_acoustic",
  "raw_intensity",
  "raw_tempo",
  "raw_vocal",
  "raw_complexity",
  "raw_bpm",
  "selected_via",
  "proxy_listeners",
  "release_groups",
  "comps",
  "va_comps",
  "market",
  "artist_rank",
  "hit_pct",
  "tier",
] as const;

/** sha256 over the rows' JSON in track_id order: identical content ⇔ identical digest. */
export function digestSql(table: string): string {
  return `SELECT sha256(string_agg(sha256(to_json(t)::VARCHAR), '' ORDER BY t.track_id)) AS digest
          FROM (SELECT ${CATALOG_COLUMNS.join(", ")} FROM ${table}) t`;
}

export async function exportParquet(
  db: Db,
  table: string,
  file: string,
): Promise<{ bytes: number; digest: string }> {
  await mkdir(path.dirname(file), { recursive: true });
  await db.run(`
    COPY (SELECT ${CATALOG_COLUMNS.join(", ")} FROM ${table} ORDER BY track_id)
    TO ${pathLit(file)} (FORMAT parquet, COMPRESSION zstd, ROW_GROUP_SIZE 122880);
  `);
  return { bytes: (await stat(file)).size, digest: await db.value<string>(digestSql(table)) };
}
