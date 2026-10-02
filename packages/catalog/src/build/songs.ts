// Stages 3–6: canonical songs, popularity proxy, attributes (HANDOFF §6.2 stages 2–5, 8; §6.6).
import { type Db, lit } from "../db.ts";
import type { Pool } from "./genres.ts";

export interface DedupeConfig {
  /** A second version type of the same song (e.g. an iconic live take) needs this many listeners… */
  readonly minListeners: number;
  /** …and at least this share of the top version's listeners. */
  readonly minShare: number;
}

/**
 * Title scripts that identify a language well enough to fill in a missing one. Only scripts used
 * by essentially one catalog language: Arabic and Cyrillic script each cover several.
 */
const SCRIPT_LANGUAGES: readonly [script: string, iso: string][] = [["Hebrew", "heb"]];

/** Version noise stripped from titles before keying (§6.2 stage 2); remixes stay distinct. */
const NOISE = String.raw`re-?master(?:ed)?|live|feat\.?|featuring|ft\.?|radio edit|radio version|radio mix|single version|single edit|album version|mono|stereo|explicit|clean|bonus track|original mix|\d{4} version|\d{4} mix`;

export const NORMALIZE_MACROS = String.raw`
CREATE OR REPLACE MACRO norm_text(s) AS
  trim(regexp_replace(lower(strip_accents(s)), '[^\p{L}\p{N}]+', ' ', 'g'));
CREATE OR REPLACE MACRO strip_version(s) AS
  regexp_replace(
    regexp_replace(
      regexp_replace(lower(s), '\s*[\(\[][^\)\]]*\b(?:${NOISE})\b[^\)\]]*[\)\]]', '', 'g'),
      '\s+[-–—]\s+[^-–—]*\b(?:${NOISE})\b.*$', ''),
    '\s+(?:feat\.?|ft\.|featuring)\s.*$', '');
CREATE OR REPLACE MACRO norm_title(s) AS
  coalesce(nullif(norm_text(strip_version(s)), ''), nullif(norm_text(s), ''), lower(s));
CREATE OR REPLACE MACRO version_type(title, comment) AS
  CASE WHEN regexp_matches(lower(title), '[\(\[][^\)\]]*\blive\b|\s[-–—]\s[^-–—]*\blive\b')
         OR regexp_matches(lower(coalesce(comment, '')), '^live\b')
       THEN 'live' ELSE 'studio' END;
CREATE OR REPLACE MACRO decade_of(y) AS
  CASE WHEN y IS NULL THEN NULL WHEN y < 1960 THEN 'dec50' WHEN y < 1970 THEN 'dec60' WHEN y < 1980 THEN 'dec70'
       WHEN y < 1990 THEN 'dec80' WHEN y < 2000 THEN 'dec90' WHEN y < 2010 THEN 'dec00' WHEN y < 2020 THEN 'dec10'
       ELSE 'dec20' END;
CREATE OR REPLACE MACRO script_lang(title) AS
  CASE ${SCRIPT_LANGUAGES.map(([script, iso]) => `WHEN regexp_matches(title, '\\p{${script}}') THEN '${iso}'`).join(" ")} END;
CREATE OR REPLACE MACRO lang_bucket(iso) AS
  CASE WHEN iso IS NULL OR iso = 'und' THEN 'unknown' WHEN iso = 'eng' THEN 'lang_en' WHEN iso = 'heb' THEN 'lang_he'
       WHEN iso = 'fra' THEN 'lang_fr' WHEN iso = 'spa' THEN 'lang_es' WHEN iso = 'zxx' THEN 'none'
       ELSE 'lang_other' END;
`;

/** What seeds songs outside the top lists: pool countries and title scripts (sorted, unique). */
export function poolSeeds(pools: readonly Pool[]): { countries: string[]; scripts: string[] } {
  return {
    countries: [...new Set(pools.flatMap((p) => p.countries))].sort(),
    scripts: [...new Set(pools.flatMap((p) => (p.script ? [p.script] : [])))].sort(),
  };
}

/**
 * Recordings → canonical groups (ListenBrainz canonical redirects) → songs keyed by
 * (first credited artist, normalized title, version type), with ListenBrainz popularity.
 * Pool seeds (artists from a pool country, titles in a pool script) become songs even when no
 * top list has them; their popularity comes from the API stage alone.
 */
export async function buildSongs(
  db: Db,
  dedupe: DedupeConfig,
  pools: readonly Pool[] = [],
): Promise<void> {
  const { countries, scripts } = poolSeeds(pools);
  const seedTitle = scripts.length
    ? scripts.map((s) => `regexp_matches(r.name, '\\p{${s}}')`).join(" OR ")
    : "false";
  await db.run(NORMALIZE_MACROS);
  await db.run(`
    -- Any recording MBID, current or merged away, → current recording id.
    CREATE OR REPLACE TABLE rec_gid AS
      SELECT gid, id FROM mb_recording UNION ALL SELECT gid, new_id AS id FROM mb_recording_redirect;

    -- DISTINCT ON guards against a recording listed twice in the canonical CSV (lowest canon id wins).
    CREATE OR REPLACE TABLE rec_canon AS
      SELECT DISTINCT ON (r.id) r.id AS recording, coalesce(cg.id, r.id) AS canon
      FROM mb_recording r
      LEFT JOIN cn_rec c ON c.recording = r.gid
      LEFT JOIN rec_gid cg ON cg.gid = c.canonical
      ORDER BY r.id, cg.id NULLS LAST;

    -- Per-user top lists, resolved to canonical recordings.
    CREATE OR REPLACE TABLE lb_canon AS
      SELECT l.user_id, rc.canon, l.gid AS lb_gid, l.listens
      FROM lb_rec l JOIN rec_gid g ON g.gid = l.gid JOIN rec_canon rc ON rc.recording = g.id;

    CREATE OR REPLACE TABLE canon_pop AS
      SELECT canon, count(DISTINCT user_id) AS users, sum(listens) AS listens FROM lb_canon GROUP BY canon;

    CREATE OR REPLACE TABLE rec_first_artist AS
      SELECT r.id AS recording, a.artist AS first_artist
      FROM mb_recording r JOIN mb_acn a ON a.artist_credit = r.artist_credit AND a.position = 0;

    -- Only artists someone listens to can produce songs; key every canonical recording of theirs,
    -- so unlistened remasters still contribute years, ISRCs and AcousticBrainz data.
    CREATE OR REPLACE TABLE listened_artist AS
      SELECT DISTINCT fa.first_artist FROM canon_pop cp JOIN rec_first_artist fa ON fa.recording = cp.canon;

    CREATE OR REPLACE TABLE seed_artist AS
      SELECT a.id AS first_artist
      FROM mb_artist a JOIN mb_area_country ac ON ac.area = a.area
      WHERE ac.country IN (${countries.length ? countries.map(lit).join(", ") : "NULL"});

    CREATE OR REPLACE TABLE canon_info AS
      SELECT id, gid, first_artist, norm_title(name) AS norm_title, version_type(name, comment) AS version_type, seeded
      FROM (
        SELECT r.id, r.gid, r.name, r.comment, fa.first_artist,
               fa.first_artist IN (SELECT first_artist FROM seed_artist) OR ${seedTitle} AS seeded
        FROM (SELECT DISTINCT canon FROM rec_canon) c
        JOIN mb_recording r ON r.id = c.canon
        JOIN rec_first_artist fa ON fa.recording = r.id
      ) WHERE seeded OR first_artist IN (SELECT first_artist FROM listened_artist);

    -- A unit is one (artist, title, version type); its representative is the most-listened member.
    CREATE OR REPLACE TABLE canon_unit AS
      SELECT ci.id AS canon, ci.seeded,
             first_value(ci.id) OVER (
               PARTITION BY ci.first_artist, ci.norm_title, ci.version_type
               ORDER BY coalesce(cp.users, 0) DESC, coalesce(cp.listens, 0) DESC, ci.gid) AS unit
      FROM canon_info ci LEFT JOIN canon_pop cp ON cp.canon = ci.id;

    -- Listened units, plus seeded units nobody has in a top list (0 listeners until the API stage).
    CREATE OR REPLACE TABLE unit_pop AS
      SELECT cu.unit, count(DISTINCT lc.user_id) AS listeners, coalesce(sum(lc.listens), 0) AS listens
      FROM canon_unit cu LEFT JOIN lb_canon lc ON lc.canon = cu.canon
      GROUP BY cu.unit
      HAVING count(lc.user_id) > 0 OR bool_or(cu.seeded);

    -- §6.6: one row per (artist, title); another version type only if it is popular in its own right.
    CREATE OR REPLACE TABLE song AS
      WITH ranked AS (
        SELECT up.unit AS song, ci.gid, ci.first_artist, ci.norm_title, ci.version_type, up.listeners, up.listens,
               row_number() OVER w AS rk, max(up.listeners) OVER (PARTITION BY ci.first_artist, ci.norm_title) AS top
        FROM unit_pop up JOIN canon_info ci ON ci.id = up.unit
        WINDOW w AS (PARTITION BY ci.first_artist, ci.norm_title ORDER BY up.listeners DESC, up.listens DESC, ci.gid)
      )
      SELECT song, gid, first_artist, norm_title, version_type, listeners AS proxy_listeners, listens AS proxy_listens,
             rk > 1 AS alt_version
      FROM ranked
      WHERE rk = 1 OR (listeners >= ${dedupe.minListeners} AND listeners >= ${dedupe.minShare} * top);

    CREATE OR REPLACE TABLE song_rec AS
      SELECT s.song, rc.recording
      FROM song s JOIN canon_unit cu ON cu.unit = s.song JOIN rec_canon rc ON rc.canon = cu.canon;
  `);
}

/** Year, language, country, ISRCs, release and credits for every song. */
export async function buildAttributes(db: Db): Promise<void> {
  await db.run(`
    CREATE OR REPLACE TABLE song_year AS
      SELECT sr.song, min(fd.year) AS year
      FROM song_rec sr JOIN mb_first_date fd ON fd.recording = sr.recording
      WHERE fd.year BETWEEN 1800 AND 2100
      GROUP BY sr.song;

    CREATE OR REPLACE TABLE song_isrc AS
      SELECT sr.song, list(DISTINCT i.isrc ORDER BY i.isrc) AS isrcs
      FROM song_rec sr JOIN mb_isrc i ON i.recording = sr.recording
      GROUP BY sr.song;

    -- Lyrics language from works this song performs (most common, ties by code).
    CREATE OR REPLACE TABLE song_work_lang AS
      SELECT song, first(lang ORDER BY n DESC, lang) AS lang
      FROM (
        SELECT sr.song, wl.lang, count(*) AS n
        FROM song_rec sr JOIN mb_rec_work rw ON rw.recording = sr.recording JOIN mb_work_lang wl ON wl.work = rw.work
        GROUP BY sr.song, wl.lang
      ) GROUP BY song;

    -- The canonical release; songs newer than the canonical dump fall back to their earliest release.
    CREATE OR REPLACE TABLE song_release AS
      WITH canonical AS (
        SELECT s.song, rel.id AS release
        FROM song s JOIN cn_rec c ON c.recording = s.gid JOIN mb_release rel ON rel.gid = c.canonical_release
      ), earliest AS (
        SELECT rr.recording AS song, first(rr.release ORDER BY ry.year NULLS LAST, rr.release) AS release
        FROM mb_rec_release rr LEFT JOIN mb_release_year ry ON ry.release = rr.release
        WHERE rr.recording IN (SELECT song FROM song) AND rr.recording NOT IN (SELECT song FROM canonical)
        GROUP BY rr.recording
      )
      SELECT x.song, rel.id AS release, rel.name AS release_title, rel.release_group, l.iso_code_3 AS release_lang
      FROM (SELECT * FROM canonical UNION ALL SELECT * FROM earliest) x
      JOIN mb_release rel ON rel.id = x.release
      LEFT JOIN mb_language l ON l.id = rel.language;

    CREATE OR REPLACE TABLE credit_mbids AS
      SELECT n.artist_credit, list(a.gid::VARCHAR ORDER BY n.position) AS artist_mbids
      FROM mb_acn n JOIN mb_artist a ON a.id = n.artist
      WHERE n.artist_credit IN (SELECT r.artist_credit FROM song s JOIN mb_recording r ON r.id = s.song)
      GROUP BY n.artist_credit;

    CREATE OR REPLACE TABLE song_credit AS
      SELECT s.song, r.name AS title, r.length_ms, ac.name AS artist_credit, cm.artist_mbids
      FROM song s JOIN mb_recording r ON r.id = s.song
      JOIN mb_artist_credit ac ON ac.id = r.artist_credit
      JOIN credit_mbids cm ON cm.artist_credit = r.artist_credit;

    CREATE OR REPLACE TABLE song_attr AS
      SELECT s.song, s.gid, s.first_artist, fa.gid AS first_artist_gid, s.version_type, s.alt_version,
             s.proxy_listeners, s.proxy_listens,
             c.title, c.artist_credit, c.artist_mbids, c.length_ms,
             y.year, decade_of(y.year) AS decade,
             coalesce(wl.lang, r.release_lang, script_lang(c.title)) AS language_iso,
             lang_bucket(coalesce(wl.lang, r.release_lang, script_lang(c.title))) AS language,
             ac.country AS artist_country,
             coalesce(i.isrcs, []::VARCHAR[]) AS isrcs,
             r.release_title, r.release_group
      FROM song s
      JOIN song_credit c USING (song)
      JOIN mb_artist fa ON fa.id = s.first_artist
      LEFT JOIN song_year y USING (song)
      LEFT JOIN song_work_lang wl USING (song)
      LEFT JOIN song_release r USING (song)
      LEFT JOIN mb_area_country ac ON ac.area = fa.area
      LEFT JOIN song_isrc i USING (song);
  `);
}
