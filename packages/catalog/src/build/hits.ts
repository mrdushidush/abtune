// Stage "hits": which songs people actually know (owner decisions D2/D5, 2026-10-03).
// The ListenBrainz popularity API counts (mostly Last.fm histories up to ~2013) rank album cuts of
// indie-leaning listeners above radio hits, so the catalog gets its own hit signal and a "hits
// view": each artist's best-known songs, inside the best-known share of their decade.
import { type Db, lit } from "../db.ts";
import type { IlArtists } from "../il-artists.ts";
import { NORMALIZE_MACROS } from "./songs.ts";

export interface HitsConfig {
  /** An artist's top this-many songs can be hits (the artist-top-3 rule). */
  readonly topSongs: number;
  /** International songs: hits come from the best-known share of each decade. */
  readonly decadeShare: number;
  /** Weight of Various-Artists compilation counts against proxy listeners in the hit key. */
  readonly vaWeight: number;
  /** Without a curated Israeli list, this many Israeli artists (by our own fame score) count as known. */
  readonly ilFallbackArtists: number;
}

export const DEFAULT_HITS: HitsConfig = {
  topSongs: 3,
  decadeShare: 0.1,
  vaWeight: 0.5,
  ilFallbackArtists: 700,
};

/** MusicBrainz's "Various Artists" placeholder: its compilations are the hit compilations. */
const VARIOUS_ARTISTS = "89ad4ac3-39f7-470e-963a-56509c546377";
/** Official, promotion (or no status): bootlegs and pseudo-releases don't make a song a hit. */
const RELEASE_STATUS = "(r.status IS NULL OR r.status IN (1, 2))";

/**
 * sel_hits, one row per selected song:
 * - `proxy_listeners`: ListenBrainz users with the song in their all-time top 1000.
 * - `release_groups`, `comps`, `va_comps`: release groups holding the song; compilations;
 *   Various-Artists compilations ("Now That's What I Call Music" and friends).
 * - `market`: `il` for curated Israeli artists and Hebrew songs by Israeli (or unplaced) artists,
 *   ranked on their own because the popularity data barely sees Israeli listeners; else `intl`.
 * - `artist_rank`: rank within the first artist. International: mean within-artist percentile of
 *   proxy listeners and VA compilations (the artist's real hit is in its top 3 for 95% of a
 *   74-hit test set). Israeli: the owner's pinned songs first, then listeners, release groups
 *   and VA compilations.
 * - `hit_pct`: percentile of the hit key within (decade, market); `popularity_pct` within market.
 * - `tier`: 0 = the hits view; 1 = another song by an artist with a hit (a deep cut by an artist
 *   you know); 2 = the rest.
 */
export async function buildHits(
  db: Db,
  cfg: HitsConfig,
  il: IlArtists,
): Promise<Record<string, unknown>> {
  await db.run(NORMALIZE_MACROS);
  const cur = il.artists.map((a, i) => `(${lit(a.mbid)}::UUID, ${a.tier}, ${i + 1})`);
  const pins = il.artists.flatMap((a) =>
    a.songs.map((s, k) => `(${lit(a.mbid)}::UUID, ${k + 1}, ${lit(s)})`),
  );
  await db.run(`
    CREATE OR REPLACE TABLE il_cur (mbid UUID, tier INTEGER, pos INTEGER);
    ${cur.length ? `INSERT INTO il_cur VALUES ${cur.join(", ")};` : ""}
    CREATE OR REPLACE TABLE il_pin_raw (mbid UUID, k INTEGER, title VARCHAR);
    ${pins.length ? `INSERT INTO il_pin_raw VALUES ${pins.join(", ")};` : ""}
    CREATE OR REPLACE TABLE il_pin AS SELECT mbid, k, title, norm_title(title) AS nt FROM il_pin_raw;

    CREATE OR REPLACE TABLE hit_rel AS
      SELECT DISTINCT sr.song, r.release_group
      FROM sel s JOIN song_rec sr USING (song)
      JOIN mb_rec_release rr ON rr.recording = sr.recording
      JOIN mb_release r ON r.id = rr.release
      WHERE ${RELEASE_STATUS};

    CREATE OR REPLACE TABLE va_credit AS
      SELECT DISTINCT n.artist_credit FROM mb_acn n JOIN mb_artist a ON a.id = n.artist
      WHERE a.gid = ${lit(VARIOUS_ARTISTS)}::UUID;

    CREATE OR REPLACE TABLE hit_sig AS
      SELECT s.song,
             count(h.release_group) AS release_groups,
             count(h.release_group) FILTER (WHERE c.release_group IS NOT NULL) AS comps,
             count(h.release_group) FILTER (WHERE c.release_group IS NOT NULL AND v.artist_credit IS NOT NULL) AS va_comps
      FROM sel s
      LEFT JOIN hit_rel h USING (song)
      LEFT JOIN (SELECT DISTINCT release_group FROM mb_rg_secondary WHERE type = 'compilation') c
        ON c.release_group = h.release_group
      LEFT JOIN mb_release_group g ON g.id = h.release_group
      LEFT JOIN va_credit v ON v.artist_credit = g.artist_credit
      GROUP BY s.song;

    CREATE OR REPLACE TABLE hit_base AS
      SELECT s.song, s.gid, s.first_artist, s.first_artist_gid, s.decade, s.listeners, s.proxy_listeners,
             norm_title(s.title) AS nt, g.release_groups, g.comps, g.va_comps, c.tier AS cur_tier,
             c.mbid IS NOT NULL
               OR (s.language = 'lang_he' AND (s.artist_country = 'IL' OR s.artist_country IS NULL)) AS il
      FROM sel s JOIN hit_sig g USING (song) LEFT JOIN il_cur c ON c.mbid = s.first_artist_gid;

    -- Israeli artists: curated, or mostly Israeli-market songs. Our own fame score ranks them when
    -- there is no curated list, and orders artists of the same curated tier.
    CREATE OR REPLACE TABLE hit_artist AS
      WITH a AS (
        SELECT first_artist, max(first_artist_gid) AS gid, max(cur_tier) AS cur_tier,
               count(*) FILTER (WHERE il) AS il_songs, count(*) FILTER (WHERE NOT il) AS intl_songs,
               round(ln(1 + count(*) FILTER (WHERE il))
                     + ln(1 + coalesce(sum(comps) FILTER (WHERE il), 0))
                     + 0.5 * ln(1 + coalesce(max(listeners) FILTER (WHERE il), 0)), 6) AS il_fame
        FROM hit_base GROUP BY first_artist
      ), b AS (
        SELECT *, cur_tier IS NOT NULL OR (il_songs > 0 AND il_songs >= intl_songs) AS il_artist FROM a
      )
      SELECT *, CASE WHEN il_artist
                     THEN row_number() OVER (PARTITION BY il_artist ORDER BY il_fame DESC, gid) END AS il_fame_rank
      FROM b;

    CREATE OR REPLACE TABLE hit_pin AS
      SELECT b.song, min(p.k) AS pin
      FROM hit_base b JOIN il_pin p ON p.mbid = b.first_artist_gid AND p.nt = b.nt
      GROUP BY b.song;

    CREATE OR REPLACE TABLE hit_rank AS
      WITH pr AS (
        SELECT b.*, a.il_artist, a.il_fame, a.il_fame_rank, p.pin,
               percent_rank() OVER (PARTITION BY b.first_artist ORDER BY b.proxy_listeners) AS pr_p,
               percent_rank() OVER (PARTITION BY b.first_artist ORDER BY b.va_comps) AS pr_v,
               percent_rank() OVER (PARTITION BY b.first_artist ORDER BY b.listeners) AS pr_l,
               percent_rank() OVER (PARTITION BY b.first_artist ORDER BY b.release_groups) AS pr_r
        FROM hit_base b JOIN hit_artist a USING (first_artist) LEFT JOIN hit_pin p USING (song)
      )
      SELECT *, row_number() OVER (
                  PARTITION BY first_artist
                  ORDER BY pin NULLS LAST,
                           CASE WHEN il_artist THEN (pr_l + pr_r + pr_v) / 3 ELSE (pr_p + pr_v) / 2 END DESC,
                           proxy_listeners DESC, listeners DESC, gid) AS artist_rank
      FROM pr;

    -- The hit key: international songs by proxy listeners plus VA compilations; Israeli songs by
    -- curated tier, then artist fame, then the song's rank within its artist.
    CREATE OR REPLACE TABLE hit_key AS
      SELECT *, CASE WHEN il THEN 'il' ELSE 'intl' END AS market,
             round(CASE WHEN il THEN 100 * coalesce(4 - cur_tier, 0) + il_fame - 2 * ln(artist_rank)
                        ELSE ln(1 + proxy_listeners) + ${cfg.vaWeight} * ln(1 + va_comps) END, 6) AS hit_key
      FROM hit_rank;

    CREATE OR REPLACE TABLE hit_view AS
      WITH w AS (
        SELECT *,
               row_number() OVER (PARTITION BY decade, market ORDER BY hit_key DESC, gid) AS dec_rank,
               count(*) OVER (PARTITION BY decade, market) AS dec_n,
               percent_rank() OVER (PARTITION BY decade, market ORDER BY hit_key, gid) AS hit_pct,
               percent_rank() OVER (PARTITION BY market ORDER BY hit_key, gid) AS market_pct
        FROM hit_key
      )
      SELECT *,
             artist_rank <= ${cfg.topSongs} AND CASE
               WHEN market = 'intl' THEN decade IS NOT NULL AND dec_rank <= ceil(${cfg.decadeShare} * dec_n)
               WHEN ${il.artists.length > 0} THEN cur_tier IS NOT NULL
               ELSE il_fame_rank <= ${cfg.ilFallbackArtists} END AS is_hit
      FROM w;

    CREATE OR REPLACE TABLE sel_hits AS
      SELECT song, proxy_listeners, release_groups, comps, va_comps, market,
             least(artist_rank, 32767)::SMALLINT AS artist_rank,
             round(hit_pct, 6)::DOUBLE AS hit_pct, round(market_pct, 6)::DOUBLE AS popularity_pct,
             (CASE WHEN is_hit THEN 0
                   WHEN bool_or(is_hit) OVER (PARTITION BY first_artist) THEN 1
                   ELSE 2 END)::UTINYINT AS tier
      FROM hit_view;
  `);

  const tiers = await db.all<{ market: string; tier: number; n: number }>(
    `SELECT market, tier, count(*) AS n FROM sel_hits GROUP BY ALL ORDER BY market, tier`,
  );
  const unknownArtists = await db.all<{ mbid: string }>(`
    SELECT mbid::VARCHAR AS mbid FROM il_cur
    WHERE mbid NOT IN (SELECT first_artist_gid FROM hit_base) ORDER BY pos`);
  const unmatchedPins = await db.all<{ mbid: string; title: string }>(`
    SELECT p.mbid::VARCHAR AS mbid, p.title FROM il_pin p
    WHERE NOT EXISTS (SELECT 1 FROM hit_base b WHERE b.first_artist_gid = p.mbid AND b.nt = p.nt)
    ORDER BY p.mbid, p.k`);
  return {
    tiers: Object.fromEntries(tiers.map((t) => [`${t.market}:${t.tier}`, t.n])),
    hits: tiers.filter((t) => t.tier === 0).reduce((a, t) => a + t.n, 0),
    curatedArtists: il.artists.length,
    unknownArtists: unknownArtists.map((r) => r.mbid),
    unmatchedPins: unmatchedPins.map((r) => `${r.mbid}: ${r.title}`),
  };
}
