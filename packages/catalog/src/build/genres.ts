// Stages 4–7: candidates, genre clusters from tags (with AcousticBrainz fallback), non-music filter.
import { type Db, lit } from "../db.ts";

export interface Pool {
  /** Short name used in reports and the `via` column, e.g. "he". */
  readonly name: string;
  /** Artist countries (ISO 3166-1 alpha-2) that put a song in the pool. */
  readonly countries: readonly string[];
  /** Lyrics/release languages (ISO 639-3) that put a song in the pool. */
  readonly languages: readonly string[];
  /**
   * Unicode script (e.g. "Hebrew") whose titles seed the pool. Pool songs are built even when no
   * ListenBrainz top list has them, so the popularity API can rank the long tail.
   */
  readonly script?: string;
  /** Minimum songs from this pool in the final catalog. */
  readonly min: number;
}

export function poolPredicate(pool: Pool, alias = ""): string {
  const a = alias ? `${alias}.` : "";
  const parts: string[] = [];
  if (pool.countries.length)
    parts.push(`${a}artist_country IN (${pool.countries.map(lit).join(", ")})`);
  if (pool.languages.length)
    parts.push(`${a}language_iso IN (${pool.languages.map(lit).join(", ")})`);
  return parts.length ? `(${parts.join(" OR ")})` : "false";
}

/** Candidates: the top `limit` songs by the dump-derived popularity proxy, plus every pool song. */
export async function buildCandidates(
  db: Db,
  limit: number,
  pools: readonly Pool[],
): Promise<void> {
  const inPool = pools.map((p) => poolPredicate(p)).join(" OR ") || "false";
  await db.run(`
    CREATE OR REPLACE TABLE cand AS
      SELECT * FROM (
        SELECT *, row_number() OVER (ORDER BY proxy_listeners DESC, proxy_listens DESC, gid) AS proxy_rank
        FROM song_attr
      ) WHERE proxy_rank <= ${limit} OR ${inPool};
    CREATE OR REPLACE TABLE cand_rec AS SELECT sr.* FROM song_rec sr SEMI JOIN cand USING (song);
  `);
}

/** Level weights for blending tag evidence (recording : release group : artist), §6.2 stage 6. */
const LEVELS = `CASE lvl WHEN 'recording' THEN 1.0 WHEN 'release_group' THEN 0.5 ELSE 0.25 END`;

export async function buildGenres(db: Db): Promise<void> {
  await db.run(`
    CREATE OR REPLACE TABLE cand_tag AS
      SELECT ct.song, ct.lvl, t.name AS tag, ct.votes
      FROM (
        SELECT cr.song, 'recording' AS lvl, rt.tag, sum(rt.votes) AS votes
        FROM cand_rec cr JOIN mb_recording_tag rt ON rt.entity = cr.recording GROUP BY ALL
        UNION ALL
        SELECT c.song, 'release_group', gt.tag, sum(gt.votes)
        FROM cand c JOIN mb_rg_tag gt ON gt.entity = c.release_group GROUP BY ALL
        UNION ALL
        SELECT c.song, 'artist', art.tag, sum(art.votes)
        FROM cand c JOIN mb_artist_tag art ON art.entity = c.first_artist GROUP BY ALL
      ) ct JOIN mb_tag t ON t.id = ct.tag;

    -- Cluster evidence per level, normalized within the level, then blended across levels.
    CREATE OR REPLACE TABLE cand_cluster_raw AS
      WITH lvl AS (
        SELECT ct.song, ct.lvl, m.key AS cluster, sum(ct.votes * m.value::DECIMAL(9, 4)) AS v
        FROM cand_tag ct JOIN tm_tag m ON m.tag = ct.tag JOIN dim_cluster d ON d.cluster = m.key
        GROUP BY ALL
      ), nrm AS (
        -- DECIMAL keeps the cross-level sums exact, so parallel aggregation can't reorder them.
        SELECT song, lvl, cluster, (v / sum(v) OVER (PARTITION BY song, lvl))::DECIMAL(18, 9) AS w FROM lvl
      )
      SELECT song, cluster, sum(w * ${LEVELS}::DECIMAL(4, 2)) AS b
      FROM nrm GROUP BY song, cluster;

    CREATE OR REPLACE TABLE cand_genre_source AS
      SELECT song, CASE min(CASE lvl WHEN 'recording' THEN 1 WHEN 'release_group' THEN 2 ELSE 3 END)
                     WHEN 1 THEN 'recording' WHEN 2 THEN 'release_group' ELSE 'artist' END AS genre_source
      FROM cand_tag ct JOIN tm_tag m ON m.tag = ct.tag JOIN dim_cluster d ON d.cluster = m.key
      GROUP BY song;
  `);
  // Songs without mapped tags: AcousticBrainz genre classifiers (dortmund + rosamerica), damped.
  await db.run(`
    CREATE OR REPLACE TABLE cand_cluster_ab AS
      WITH probs AS (
        UNPIVOT (SELECT song, ${AB_GENRE_COLUMNS.join(", ")} FROM song_ab
                 WHERE song NOT IN (SELECT song FROM cand_genre_source) AND song IN (SELECT song FROM cand))
        ON ${AB_GENRE_COLUMNS.join(", ")} INTO NAME class VALUE p
      )
      SELECT probs.song, m.cluster, sum(probs.p::DECIMAL(12, 6) * m.value::DECIMAL(9, 4)) AS b
      FROM probs JOIN tm_ab m ON m.class = probs.class JOIN dim_cluster d ON d.cluster = m.cluster
      WHERE probs.p >= 0.3
      GROUP BY ALL;

    -- Normalize, drop weights < 0.1, keep the top 4 (ties by declaration order), renormalize.
    CREATE OR REPLACE TABLE cand_cluster AS
      WITH src AS (
        SELECT song, cluster, b FROM cand_cluster_raw
        UNION ALL SELECT song, cluster, b FROM cand_cluster_ab
      ), n AS (
        SELECT song, cluster, b / sum(b) OVER (PARTITION BY song) AS w FROM src
      ), k AS (
        SELECT n.song, n.cluster, n.w, row_number() OVER (PARTITION BY n.song ORDER BY n.w DESC, d.ord) AS rk
        FROM n JOIN dim_cluster d USING (cluster) WHERE n.w >= 0.1
      )
      SELECT song, cluster, round(w / sum(w) OVER (PARTITION BY song), 3)::FLOAT AS w, rk
      FROM k WHERE rk <= 4;

    CREATE OR REPLACE TABLE cand_genre AS
      SELECT c.song,
             coalesce(gs.genre_source, CASE WHEN c.song IN (SELECT song FROM cand_cluster_ab) THEN 'ab' ELSE 'none' END) AS genre_source,
             (SELECT cluster FROM cand_cluster cc WHERE cc.song = c.song AND cc.rk = 1) AS primary_cluster
      FROM cand c LEFT JOIN cand_genre_source gs USING (song);
  `);
  // Scalar nudges: tag means (votes × level weight) and cluster priors (§6.3 complexity, intensity).
  await db.run(`
    CREATE OR REPLACE TABLE cand_nudge AS
      WITH tagn AS (
        SELECT ct.song, m.key AS dim,
               sum(ct.votes * ${LEVELS} * m.value::DECIMAL(9, 4)) / sum(ct.votes * ${LEVELS}) AS tag_mean
        FROM cand_tag ct JOIN tm_tag m ON m.tag = ct.tag
        WHERE m.key IN ('complexity', 'intensity')
        GROUP BY ALL
      ), prior AS (
        SELECT cc.song, p.key AS dim, sum(cc.w::DECIMAL(9, 4) * p.value::DECIMAL(9, 4)) AS prior
        FROM cand_cluster cc JOIN tm_prior p ON p.cluster = cc.cluster
        GROUP BY ALL
      ), dims AS (SELECT unnest(['complexity', 'intensity']) AS dim)
      SELECT c.song, dims.dim, t.tag_mean, coalesce(p.prior, 0) AS prior
      FROM cand c CROSS JOIN dims
      LEFT JOIN tagn t ON t.song = c.song AND t.dim = dims.dim
      LEFT JOIN prior p ON p.song = c.song AND p.dim = dims.dim;
  `);
}

/** AcousticBrainz genre classifier columns used for the cluster fallback. */
export const AB_GENRE_COLUMNS = [
  "genre_dortmund__alternative",
  "genre_dortmund__blues",
  "genre_dortmund__electronic",
  "genre_dortmund__folkcountry",
  "genre_dortmund__funksoulrnb",
  "genre_dortmund__jazz",
  "genre_dortmund__pop",
  "genre_dortmund__raphiphop",
  "genre_dortmund__rock",
  "genre_rosamerica__cla",
  "genre_rosamerica__dan",
  "genre_rosamerica__hip",
  "genre_rosamerica__jaz",
  "genre_rosamerica__pop",
  "genre_rosamerica__rhy",
  "genre_rosamerica__roc",
];

/** Placeholder MusicBrainz artists that never make a real catalog entry. */
const SPECIAL_ARTISTS = [
  "Various Artists",
  "[unknown]",
  "[anonymous]",
  "[no artist]",
  "[data]",
  "[dialogue]",
];
const NON_MUSIC_RG_TYPES = [
  "audiobook",
  "spokenword",
  "interview",
  "audio drama",
  "field recording",
];
const NON_MUSIC_TITLE = String.raw`\bkaraoke\b|in the style of|originally performed by|made famous by|\btribute to\b|backing track`;

/** §6.6 drops, first matching reason wins. */
export async function buildFilters(db: Db, minLengthMs: number): Promise<void> {
  await db.run(`
    -- Non-music tags outvote genre tags at the most specific level that has either.
    CREATE OR REPLACE TABLE cand_nonmusic AS
      WITH lv AS (
        SELECT ct.song, ct.lvl,
               sum(CASE WHEN ct.tag IN (SELECT tag FROM tm_nonmusic) THEN ct.votes ELSE 0 END) AS nm,
               sum(CASE WHEN ct.tag IN (SELECT DISTINCT tag FROM tm_tag) THEN ct.votes ELSE 0 END) AS gm
        FROM cand_tag ct GROUP BY ALL
      )
      SELECT song, first(nm > gm ORDER BY CASE lvl WHEN 'recording' THEN 1 WHEN 'release_group' THEN 2 ELSE 3 END) AS flag
      FROM lv WHERE nm + gm > 0 GROUP BY song;

    CREATE OR REPLACE TABLE cand_drop AS
      SELECT c.song,
        CASE
          WHEN a.name IN (${SPECIAL_ARTISTS.map(lit).join(", ")}) THEN 'placeholder_artist'
          WHEN c.length_ms IS NOT NULL AND c.length_ms < ${minLengthMs} THEN 'too_short'
          WHEN regexp_matches(lower(c.title), '${NON_MUSIC_TITLE}') THEN 'title_pattern'
          WHEN c.release_group IN (SELECT release_group FROM mb_rg_secondary
                                   WHERE type IN (${NON_MUSIC_RG_TYPES.map(lit).join(", ")})) THEN 'release_type'
          WHEN nm.flag THEN 'non_music_tag'
        END AS reason
      FROM cand c JOIN mb_artist a ON a.id = c.first_artist LEFT JOIN cand_nonmusic nm USING (song);
  `);
}
