// Stage 8: AcousticBrainz → scalar dims (HANDOFF §6.3), imputation tiers 1–2 (§6.4).
import type { Db } from "../db.ts";
import { AB_HL_COLUMNS } from "../extract/ab.ts";

const PROB_COLUMNS = AB_HL_COLUMNS.slice(2);

/** The base mood/dance/voice classifiers whose certainty feeds feature_confidence. */
const BASE = [
  "danceability__danceable",
  "mood_happy__happy",
  "mood_sad__sad",
  "mood_relaxed__relaxed",
  "mood_party__party",
  "mood_aggressive__aggressive",
  "mood_acoustic__acoustic",
  "mood_electronic__electronic",
  "voice_instrumental__voice",
];

/** Scalars that AcousticBrainz informs (complexity is tag-derived, mainstream is popularity). */
export const AB_DIMS = [
  "energy",
  "valence",
  "dance",
  "acoustic",
  "intensity",
  "tempo",
  "vocal",
] as const;

/**
 * Clusters whose tempo is rarely below 70 BPM (halved detections get doubled) or above 165
 * (doubled detections get halved). §6.3 tempo, "correct obvious half/double-time errors".
 */
const FAST_CLUSTERS = ["edm", "house_techno", "dance_pop", "punk", "metal", "funk_disco", "kpop"];
const SLOW_CLUSTERS = [
  "hiphop",
  "rnb_soul",
  "reggae",
  "chill_ambient",
  "soundtrack",
  "classical",
  "folk",
  "blues",
];

/** Per recording: submission count and exact (DECIMAL) probability sums; per submission BPMs. */
export async function buildAbAggregates(db: Db): Promise<void> {
  const sums = PROB_COLUMNS.map((c) => `sum(h.${c}::DECIMAL(12, 5)) AS ${c}`).join(",\n        ");
  await db.run(`
    CREATE OR REPLACE TABLE ab_rec AS
      SELECT g.id AS recording, count(*) AS n,
        ${sums}
      FROM ab_hl h JOIN rec_gid g ON g.gid = h.mbid
      GROUP BY g.id;
    CREATE OR REPLACE TABLE ab_bpm AS
      SELECT g.id AS recording, r.bpm FROM ab_rhythm r JOIN rec_gid g ON g.gid = r.mbid;
  `);
}

/** Mean probabilities per song over a (song, recording) relation, plus median BPM. */
function aggregateSql(table: string, relation: string): string {
  const means = PROB_COLUMNS.map((c) => `(sum(a.${c}) / sum(a.n))::DOUBLE AS ${c}`).join(", ");
  return `
    CREATE OR REPLACE TABLE ${table} AS
      WITH p AS (
        SELECT r.song, sum(a.n) AS n, ${means}
        FROM ${relation} r JOIN ab_rec a ON a.recording = r.recording
        GROUP BY r.song
      ), t AS (
        SELECT r.song, median(b.bpm)::DOUBLE AS bpm
        FROM ${relation} r JOIN ab_bpm b ON b.recording = r.recording
        GROUP BY r.song
      )
      SELECT p.*, t.bpm FROM p LEFT JOIN t USING (song);`;
}

/** Tier 1 (`ab_direct`) for every candidate: AB data on any recording of the song. */
export async function buildTier1(db: Db): Promise<void> {
  await db.run(aggregateSql("song_ab", "cand_rec"));
}

/**
 * Tier 2 (`ab_sibling`) for selected songs without tier 1: recordings that share an ISRC with
 * the song, or perform the same work with the same first artist (covers excluded).
 */
export async function buildTier2(db: Db): Promise<void> {
  await db.run(`
    CREATE OR REPLACE TABLE sib_rec AS
      WITH need AS (SELECT song, first_artist FROM sel WHERE song NOT IN (SELECT song FROM song_ab)),
      own AS (SELECT cr.song, cr.recording FROM cand_rec cr SEMI JOIN need USING (song)),
      by_isrc AS (
        SELECT DISTINCT o.song, i2.recording
        FROM own o JOIN mb_isrc i1 ON i1.recording = o.recording JOIN mb_isrc i2 ON i2.isrc = i1.isrc
      ),
      by_work AS (
        SELECT DISTINCT o.song, w2.recording
        FROM own o JOIN mb_rec_work w1 ON w1.recording = o.recording JOIN mb_rec_work w2 ON w2.work = w1.work
        JOIN need n ON n.song = o.song
        JOIN mb_recording r2 ON r2.id = w2.recording
        JOIN mb_acn acn ON acn.artist_credit = r2.artist_credit AND acn.artist = n.first_artist
      )
      SELECT song, recording FROM (SELECT * FROM by_isrc UNION SELECT * FROM by_work)
      WHERE recording IN (SELECT recording FROM ab_rec)
        AND (song, recording) NOT IN (SELECT song, recording FROM own);
  `);
  await db.run(aggregateSql("song_ab2", "sib_rec"));
}

/** §6.3 raw dims from mean classifier probabilities (before catalog-wide quantile scaling). */
export function rawDimsSql(t: string): Record<(typeof AB_DIMS)[number] | "certainty", string> {
  return {
    energy: `2 * (0.4 * (1 - ${t}.mood_relaxed__relaxed) + 0.3 * ${t}.mood_party__party + 0.3 * ${t}.mood_aggressive__aggressive) - 1`,
    valence: `${t}.mood_happy__happy - ${t}.mood_sad__sad`,
    dance: `2 * ${t}.danceability__danceable - 1`,
    acoustic: `${t}.mood_acoustic__acoustic - ${t}.mood_electronic__electronic`,
    intensity: `2 * ${t}.mood_aggressive__aggressive - 1`,
    tempo: `${t}.tempo_raw`,
    vocal: `2 * ${t}.voice_instrumental__voice - 1`,
    certainty: `(${BASE.map((c) => `abs(2 * ${t}.${c} - 1)`).join(" + ")}) / ${BASE.length}`,
  };
}

/** BPM → tempo axis with half/double-time correction by primary cluster: 60 → −1, 180 → +1. */
export function tempoSql(bpm: string, cluster: string): string {
  const list = (xs: string[]) => xs.map((x) => `'${x}'`).join(", ");
  const corrected = `CASE WHEN ${bpm} < 70 AND ${cluster} IN (${list(FAST_CLUSTERS)}) THEN ${bpm} * 2
                          WHEN ${bpm} > 165 AND ${cluster} IN (${list(SLOW_CLUSTERS)}) THEN ${bpm} / 2
                          ELSE ${bpm} END`;
  return `greatest(-1, least(1, ((${corrected}) - 120) / 60))`;
}

/** Raw dims for candidates with tier-1 data (training set for tier 3) and tier-2 songs. */
export async function buildRawDims(db: Db): Promise<void> {
  for (const [table, out] of [
    ["song_ab", "dims_t1"],
    ["song_ab2", "dims_t2"],
  ] as const) {
    const exists = await db.value<number>(
      `SELECT count(*) FROM information_schema.tables WHERE table_name = '${table}'`,
    );
    if (!exists) {
      await db.run(`CREATE OR REPLACE TABLE ${out} (song INTEGER, energy DOUBLE, valence DOUBLE, dance DOUBLE,
        acoustic DOUBLE, intensity DOUBLE, tempo DOUBLE, vocal DOUBLE, certainty DOUBLE, bpm DOUBLE, n BIGINT)`);
      continue;
    }
    const d = rawDimsSql("x");
    await db.run(`
      CREATE OR REPLACE TABLE ${out} AS
        SELECT x.song, ${AB_DIMS.map((k) => `(${d[k]})::DOUBLE AS ${k}`).join(", ")},
               (${d.certainty})::DOUBLE AS certainty, x.bpm, x.n
        FROM (
          SELECT a.*, ${tempoSql("a.bpm", "g.primary_cluster")} AS tempo_raw
          FROM ${table} a JOIN cand_genre g USING (song)
        ) x;
    `);
  }
}
