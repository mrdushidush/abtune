// Stage 2: load the extracted raw files into DuckDB tables with proper types.
import { type Db, lit, pathLit } from "../db.ts";
import { AB_HL_COLUMNS } from "../extract/ab.ts";
import { rawPaths } from "../extract/index.ts";
import { MB_TABLES } from "../mb-schema.ts";
import type { TagMapFile } from "../tagmap.ts";
import { tagMapRows } from "../tagmap.ts";

/** Postgres COPY text escapes (\\, \t, \n, \r) → characters. U+E000 guards literal backslashes. */
const PG_UNESCAPE = String.raw`
CREATE OR REPLACE MACRO pg_unescape(s) AS
  replace(replace(replace(replace(replace(s, '\\', chr(57344)), '\t', chr(9)), '\n', chr(10)), '\r', chr(13)),
          chr(57344), '\');`;

/** A headerless MusicBrainz TSV as all-VARCHAR columns. */
function mbSource(raw: string, table: string): string {
  const def = MB_TABLES.find((t) => t.name === table);
  if (!def) throw new Error(`unknown MusicBrainz table ${table}`);
  const columns = `{${def.columns.map((c) => `${lit(c)}: 'VARCHAR'`).join(", ")}}`;
  return String.raw`read_csv(${pathLit(rawPaths(raw).mbTable(def.dump, table))}, delim='\t', header=false,
    quote='', escape='', nullstr='\N', columns=${columns}, auto_detect=false, max_line_size=10000000)`;
}

export async function loadMusicBrainz(db: Db, raw: string): Promise<void> {
  const src = (t: string) => mbSource(raw, t);
  await db.run(PG_UNESCAPE);
  await db.run(`
    CREATE OR REPLACE TABLE mb_recording AS
      SELECT id::INTEGER AS id, gid::UUID AS gid, pg_unescape(name) AS name, artist_credit::INTEGER AS artist_credit,
             length::INTEGER AS length_ms, pg_unescape(comment) AS comment
      FROM ${src("recording")};
    CREATE OR REPLACE TABLE mb_recording_redirect AS
      SELECT gid::UUID AS gid, new_id::INTEGER AS new_id FROM ${src("recording_gid_redirect")};
    -- Earliest release event of each release, then of each recording across all its releases (§6.2 stage 4).
    CREATE OR REPLACE TABLE mb_release_year AS
      SELECT release::INTEGER AS release, min(date_year::SMALLINT) AS year
      FROM (SELECT release, date_year FROM ${src("release_country")}
            UNION ALL SELECT release, date_year FROM ${src("release_unknown_country")})
      WHERE date_year IS NOT NULL
      GROUP BY 1;
    CREATE OR REPLACE TABLE mb_medium AS SELECT id::INTEGER AS id, release::INTEGER AS release FROM ${src("medium")};
    -- recording → release, via tracks on media.
    CREATE OR REPLACE TABLE mb_rec_release AS
      SELECT DISTINCT t.recording::INTEGER AS recording, m.release
      FROM ${src("track")} t JOIN mb_medium m ON m.id = t.medium::INTEGER;
    CREATE OR REPLACE TABLE mb_first_date AS
      SELECT rr.recording, min(ry.year) AS year
      FROM mb_rec_release rr JOIN mb_release_year ry ON ry.release = rr.release
      GROUP BY 1;
    CREATE OR REPLACE TABLE mb_release AS
      SELECT id::INTEGER AS id, gid::UUID AS gid, pg_unescape(name) AS name, release_group::INTEGER AS release_group,
             status::INTEGER AS status, language::INTEGER AS language
      FROM ${src("release")};
    CREATE OR REPLACE TABLE mb_rg_secondary AS
      SELECT j.release_group::INTEGER AS release_group, lower(t.name) AS type
      FROM ${src("release_group_secondary_type_join")} j JOIN ${src("release_group_secondary_type")} t ON t.id = j.secondary_type;
    CREATE OR REPLACE TABLE mb_artist AS
      SELECT id::INTEGER AS id, gid::UUID AS gid, pg_unescape(name) AS name, area::INTEGER AS area FROM ${src("artist")};
    CREATE OR REPLACE TABLE mb_artist_credit AS
      SELECT id::INTEGER AS id, pg_unescape(name) AS name FROM ${src("artist_credit")};
    CREATE OR REPLACE TABLE mb_acn AS
      SELECT artist_credit::INTEGER AS artist_credit, position::SMALLINT AS position, artist::INTEGER AS artist
      FROM ${src("artist_credit_name")};
    CREATE OR REPLACE TABLE mb_iso AS SELECT area::INTEGER AS area, code FROM ${src("iso_3166_1")};
    CREATE OR REPLACE TABLE mb_link_type AS
      SELECT id::INTEGER AS id, entity_type0, entity_type1, name FROM ${src("link_type")};
    CREATE OR REPLACE TABLE mb_link AS SELECT id::INTEGER AS id, link_type::INTEGER AS link_type FROM ${src("link")};
    CREATE OR REPLACE TABLE mb_area_parent AS
      SELECT l.entity1::INTEGER AS child, l.entity0::INTEGER AS parent
      FROM ${src("l_area_area")} l JOIN mb_link k ON k.id = l.link::INTEGER JOIN mb_link_type t ON t.id = k.link_type
      WHERE t.entity_type0 = 'area' AND t.entity_type1 = 'area' AND t.name = 'part of';
    CREATE OR REPLACE TABLE mb_rec_work AS
      SELECT DISTINCT l.entity0::INTEGER AS recording, l.entity1::INTEGER AS work
      FROM ${src("l_recording_work")} l JOIN mb_link k ON k.id = l.link::INTEGER JOIN mb_link_type t ON t.id = k.link_type
      WHERE t.entity_type0 = 'recording' AND t.entity_type1 = 'work' AND t.name = 'performance';
    CREATE OR REPLACE TABLE mb_language AS SELECT id::INTEGER AS id, iso_code_3 FROM ${src("language")};
    CREATE OR REPLACE TABLE mb_work_lang AS
      SELECT w.work::INTEGER AS work, l.iso_code_3 AS lang
      FROM ${src("work_language")} w JOIN mb_language l ON l.id = w.language::INTEGER
      WHERE l.iso_code_3 IS NOT NULL;
    CREATE OR REPLACE TABLE mb_isrc AS SELECT DISTINCT recording::INTEGER AS recording, isrc FROM ${src("isrc")};
    CREATE OR REPLACE TABLE mb_tag AS SELECT id::INTEGER AS id, lower(trim(pg_unescape(name))) AS name FROM ${src("tag")};
    CREATE OR REPLACE TABLE mb_recording_tag AS
      SELECT recording::INTEGER AS entity, tag::INTEGER AS tag, count::INTEGER AS votes
      FROM ${src("recording_tag")} WHERE count::INTEGER > 0;
    CREATE OR REPLACE TABLE mb_rg_tag AS
      SELECT release_group::INTEGER AS entity, tag::INTEGER AS tag, count::INTEGER AS votes
      FROM ${src("release_group_tag")} WHERE count::INTEGER > 0;
    CREATE OR REPLACE TABLE mb_artist_tag AS
      SELECT artist::INTEGER AS entity, tag::INTEGER AS tag, count::INTEGER AS votes
      FROM ${src("artist_tag")} WHERE count::INTEGER > 0;
  `);
  // Artist area → ISO country, walking "part of" links upward (cities → regions → countries).
  // Only areas that artists use; nearest country wins, ties by code.
  await db.run(`
    CREATE OR REPLACE TABLE mb_area_country AS
    WITH RECURSIVE up(area, cur, depth) AS (
      SELECT DISTINCT area, area, 0 FROM mb_artist WHERE area IS NOT NULL
      UNION ALL
      SELECT up.area, p.parent, up.depth + 1
      FROM up JOIN mb_area_parent p ON p.child = up.cur
      WHERE up.depth < 8 AND up.cur NOT IN (SELECT area FROM mb_iso)
    )
    SELECT up.area, first(i.code ORDER BY up.depth, i.code) AS country
    FROM up JOIN mb_iso i ON i.area = up.cur
    GROUP BY up.area;
  `);
}

export async function loadCanonical(db: Db, raw: string): Promise<void> {
  const p = rawPaths(raw);
  await db.run(`
    CREATE OR REPLACE TABLE cn_rec AS
      SELECT recording_mbid::UUID AS recording, canonical_recording_mbid::UUID AS canonical,
             canonical_release_mbid::UUID AS canonical_release
      FROM read_csv(${pathLit(p.canonicalRecording)}, header=true, auto_detect=false,
        columns={'recording_mbid': 'VARCHAR', 'canonical_recording_mbid': 'VARCHAR', 'canonical_release_mbid': 'VARCHAR'});
  `);
}

export async function loadListenBrainz(db: Db, raw: string): Promise<void> {
  await db.run(String.raw`
    CREATE OR REPLACE TABLE lb_rec AS
      SELECT user_id, gid, listens
      FROM read_csv(${pathLit(rawPaths(raw).lbRecordings)}, delim='\t', header=false, quote='', escape='', auto_detect=false,
        columns={'user_id': 'INTEGER', 'gid': 'UUID', 'listens': 'INTEGER'});
  `);
}

export async function loadAcousticBrainz(db: Db, raw: string): Promise<void> {
  const p = rawPaths(raw);
  const cols = AB_HL_COLUMNS.map(
    (c, i) => `${lit(c)}: '${i === 0 ? "UUID" : i === 1 ? "INTEGER" : "FLOAT"}'`,
  );
  await db.run(String.raw`
    CREATE OR REPLACE TABLE ab_hl AS
      SELECT * FROM read_csv(${pathLit(p.abHighlevelGlob)}, delim='\t', header=false, quote='', escape='',
        auto_detect=false, columns={${cols.join(", ")}});
    CREATE OR REPLACE TABLE ab_rhythm AS
      SELECT mbid::UUID AS mbid, submission_offset::INTEGER AS submission, bpm::FLOAT AS bpm
      FROM read_csv(${pathLit(p.abRhythm)}, header=true, auto_detect=false,
        columns={'mbid': 'VARCHAR', 'submission_offset': 'VARCHAR', 'bpm': 'VARCHAR',
          'bpm_histogram_first_peak_bpm_mean': 'VARCHAR', 'bpm_histogram_first_peak_bpm_median': 'VARCHAR',
          'bpm_histogram_second_peak_bpm_mean': 'VARCHAR', 'bpm_histogram_second_peak_bpm_median': 'VARCHAR',
          'danceability': 'VARCHAR', 'onset_rate': 'VARCHAR'})
      WHERE TRY_CAST(bpm AS FLOAT) > 0;
  `);
}

/** The tag map as tables: tm_tag(tag, key, value), tm_prior, tm_nonmusic, tm_ab. */
export async function loadTagMap(db: Db, file: TagMapFile): Promise<void> {
  const rows = tagMapRows(file);
  const values = (list: [string, string, number][]) =>
    list.length === 0
      ? "SELECT NULL::VARCHAR, NULL::VARCHAR, NULL::DOUBLE WHERE false"
      : `VALUES ${list.map(([a, b, v]) => `(${lit(a)}, ${lit(b)}, ${v})`).join(", ")}`;
  await db.run(`
    CREATE OR REPLACE TABLE tm_tag AS SELECT * FROM (${values(rows.tags)}) t(tag, key, value);
    CREATE OR REPLACE TABLE tm_prior AS SELECT * FROM (${values(rows.priors)}) t(cluster, key, value);
    CREATE OR REPLACE TABLE tm_ab AS SELECT * FROM (${values(rows.abGenres)}) t(class, cluster, value);
    CREATE OR REPLACE TABLE tm_nonmusic AS SELECT unnest([${rows.nonMusic.map(lit).join(", ")}]::VARCHAR[]) AS tag;
  `);
}

/** Dimension order from the bank, so cluster/decade/language codes are declaration-ordered. */
export async function loadDimensions(
  db: Db,
  dims: { readonly genres: readonly string[]; readonly decades: readonly string[] },
): Promise<void> {
  await db.run(`
    CREATE OR REPLACE TABLE dim_cluster AS
      SELECT * FROM (VALUES ${dims.genres.map((g, i) => `(${lit(g)}, ${i})`).join(", ")}) t(cluster, ord);
    CREATE OR REPLACE TABLE dim_decade AS
      SELECT * FROM (VALUES ${dims.decades.map((d, i) => `(${lit(d)}, ${i})`).join(", ")}) t(decade, ord);
  `);
}
