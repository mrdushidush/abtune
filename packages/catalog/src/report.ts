// Data quality report (HANDOFF §6.8), written to docs/catalog-report-<version>.md each build.
import { type Db, lit } from "./db.ts";
import type { ImputeReport } from "./impute.ts";
import type { CatalogManifest } from "./manifest.ts";
import type { StepRecord } from "./steps.ts";

type Dist = { key: string | null; n: number }[];

export interface CatalogStats {
  readonly tracks: number;
  readonly artists: number;
  readonly featureSource: Dist;
  readonly genreSource: Dist;
  readonly decade: Dist;
  readonly primaryCluster: Dist;
  readonly language: Dist;
  readonly isrc: { readonly withIsrc: number; readonly hebrewWithIsrc: number };
  readonly hebrew: {
    readonly lang: number;
    readonly country: number;
    readonly pool: number;
    readonly langNotCountry: number;
    readonly countryNotLang: number;
    readonly cluster: Dist;
    readonly decade: Dist;
    readonly featureSource: Dist;
    readonly topArtists: { artist: string; tracks: number; listeners: number }[];
  };
  readonly english: { readonly lang: number; readonly featureSource: Dist; readonly cluster: Dist };
  readonly post2022: { readonly n: number; readonly featureSource: Dist; readonly hebrew: number };
  readonly popularity: {
    readonly fromApi: number;
    readonly minListeners: number;
    readonly medianListeners: number;
    readonly maxListeners: number;
  };
  readonly unmappedTags: { tag: string; songs: number; votes: number }[];
  readonly selectedVia: Dist;
  readonly hits: {
    readonly tiers: { market: string; tier: number; n: number }[];
    readonly decade: Dist;
    readonly signature: SignatureRow[];
  };
}

export interface SignatureRow {
  readonly artist: string;
  readonly title: string;
  readonly rank: number;
  readonly tier: number;
  readonly proxyListeners: number;
  readonly vaComps: number;
}

/** Well-known artists whose top 3 songs the report shows, so a person can eyeball the hit signal. */
export const SIGNATURE_ARTISTS = [
  "Rihanna",
  "Ed Sheeran",
  "Adele",
  "Queen",
  "Michael Jackson",
  "The Beatles",
  "Madonna",
  "Britney Spears",
  "Taylor Swift",
  "Beyoncé",
  "Eminem",
  "Drake",
  "Coldplay",
  "Nirvana",
  "Radiohead",
  "Bon Jovi",
  "ABBA",
  "Whitney Houston",
  "Bruno Mars",
  "Lady Gaga",
  "Shakira",
  "Luis Fonsi",
  "The Weeknd",
  "Billie Eilish",
  "Dua Lipa",
  "Metallica",
  "Elvis Presley",
  "Lana Del Rey",
  "BTS",
  "עומר אדם",
  "אריק איינשטיין",
  "שלמה ארצי",
  "אייל גולן",
  "נועה קירל",
  "כוורת",
  "משינה",
  "הדג נחש",
  "שרית חדד",
  "עפרה חזה",
];

const dist = (db: Db, expr: string, where = "true", table = "catalog") =>
  db.all<{ key: string | null; n: number }>(
    `SELECT ${expr} AS key, count(*) AS n FROM ${table} WHERE ${where} GROUP BY 1 ORDER BY n DESC, key NULLS LAST`,
  );

export async function collectStats(db: Db): Promise<CatalogStats> {
  const heLang = "language = 'lang_he'";
  const heCountry = "artist_country = 'IL'";
  const hePool = `(${heLang} OR ${heCountry})`;
  const n = (where: string) => db.value<number>(`SELECT count(*) FROM catalog WHERE ${where}`);
  const pop = await db.one<{ fromApi: number; minL: number; medL: number; maxL: number }>(`
    SELECT (SELECT count(*) FROM sel s JOIN song_pop p USING (song) WHERE p.from_api) AS fromApi,
           min(listeners) AS minL, median(listeners)::BIGINT AS medL, max(listeners) AS maxL FROM catalog`);
  return {
    tracks: await n("true"),
    artists: await db.value<number>(`SELECT count(DISTINCT artist_mbids[1]) FROM catalog`),
    featureSource: await dist(db, "feature_source"),
    genreSource: await dist(db, "genre_source"),
    decade: await dist(db, "decade"),
    primaryCluster: await dist(db, "primary_cluster"),
    language: await dist(db, "language"),
    isrc: {
      withIsrc: await n("len(isrcs) > 0"),
      hebrewWithIsrc: await n(`${hePool} AND len(isrcs) > 0`),
    },
    hebrew: {
      lang: await n(heLang),
      country: await n(heCountry),
      pool: await n(hePool),
      langNotCountry: await n(`${heLang} AND artist_country IS DISTINCT FROM 'IL'`),
      countryNotLang: await n(`${heCountry} AND language <> 'lang_he'`),
      cluster: await dist(db, "primary_cluster", hePool),
      decade: await dist(db, "decade", hePool),
      featureSource: await dist(db, "feature_source", hePool),
      topArtists: await db.all(`
        SELECT artist_credit AS artist, count(*) AS tracks, max(listeners) AS listeners FROM catalog
        WHERE ${hePool} GROUP BY artist_credit ORDER BY listeners DESC, artist LIMIT 15`),
    },
    english: {
      lang: await n("language = 'lang_en'"),
      featureSource: await dist(db, "feature_source", "language = 'lang_en'"),
      cluster: await dist(db, "primary_cluster", "language = 'lang_en'"),
    },
    post2022: {
      n: await n("year >= 2023"),
      featureSource: await dist(db, "feature_source", "year >= 2023"),
      hebrew: await n(`year >= 2023 AND ${hePool}`),
    },
    popularity: {
      fromApi: pop.fromApi,
      minListeners: pop.minL,
      medianListeners: pop.medL,
      maxListeners: pop.maxL,
    },
    unmappedTags: await db.all(`
      SELECT ct.tag, count(DISTINCT ct.song) AS songs, sum(ct.votes) AS votes
      FROM cand_tag ct
      WHERE ct.song IN (SELECT song FROM sel)
        AND ct.tag NOT IN (SELECT tag FROM tm_tag) AND ct.tag NOT IN (SELECT tag FROM tm_nonmusic)
      GROUP BY ct.tag ORDER BY songs DESC, ct.tag LIMIT 50`),
    selectedVia: await dist(db, "selected_via"),
    hits: {
      tiers: await db.all(
        `SELECT market, tier, count(*) AS n FROM catalog GROUP BY ALL ORDER BY market, tier`,
      ),
      decade: await dist(db, "decade", "tier = 0"),
      signature: await signatureRows(db),
    },
  };
}

/** Each SIGNATURE_ARTISTS name → the artist most often credited exactly so → their top 3 songs. */
async function signatureRows(db: Db): Promise<SignatureRow[]> {
  const names = SIGNATURE_ARTISTS.map((n, k) => `(${k}, ${lit(n)})`).join(", ");
  return db.all<SignatureRow>(`
    WITH named AS (SELECT * FROM (VALUES ${names}) v(k, name)),
    artist AS (
      SELECT k, name, mbid FROM (
        SELECT n.k, n.name, c.artist_mbids[1] AS mbid,
               row_number() OVER (PARTITION BY n.k ORDER BY count(*) DESC, c.artist_mbids[1]) AS r
        FROM named n JOIN catalog c ON c.artist_credit = n.name GROUP BY n.k, n.name, c.artist_mbids[1]
      ) WHERE r = 1
    )
    SELECT a.name AS artist, c.title, c.artist_rank AS rank, c.tier,
           c.proxy_listeners AS "proxyListeners", c.va_comps AS "vaComps"
    FROM artist a JOIN catalog c ON c.artist_mbids[1] = a.mbid AND c.artist_rank <= 3
    ORDER BY a.k, c.artist_rank`);
}

const fmt = (x: number) => x.toLocaleString("en");
const pct = (x: number, of: number) => (of > 0 ? `${((100 * x) / of).toFixed(1)}%` : "–");

function distTable(title: string, d: Dist, total: number, limit = 40): string {
  const rows = d
    .slice(0, limit)
    .map((r) => `| ${r.key ?? "_(none)_"} | ${fmt(r.n)} | ${pct(r.n, total)} |`);
  return `| ${title} | tracks | share |\n|---|---:|---:|\n${rows.join("\n")}\n`;
}

function hitsNotes(info: Record<string, unknown> | undefined): string {
  if (!info) return "";
  const curated = Number(info.curatedArtists ?? 0);
  const unknown = (info.unknownArtists as string[] | undefined) ?? [];
  const pins = (info.unmatchedPins as string[] | undefined) ?? [];
  const lines = [
    curated > 0
      ? `Curated Israeli artists: ${fmt(curated)}.`
      : "No curated Israeli list yet: the best-known Israeli artists by our own data stand in.",
  ];
  if (unknown.length) lines.push(`Curated artists not in the catalog: ${unknown.join(", ")}.`);
  if (pins.length) lines.push(`Pinned songs not found: ${pins.join("; ")}.`);
  return `${lines.join(" ")}\n`;
}

function step(steps: readonly StepRecord[], name: string): StepRecord | undefined {
  return steps.find((s) => s.step === name);
}

export function renderReport(input: {
  readonly manifest: CatalogManifest;
  readonly stats: CatalogStats;
  readonly steps: readonly StepRecord[];
}): string {
  const { manifest: m, stats: s, steps } = input;
  const T = s.tracks;
  const imp = step(steps, "features")?.info.impute as ImputeReport | undefined;
  const cand = step(steps, "candidates")?.info as
    | { candidates?: number; drops?: Record<string, number> }
    | undefined;
  const songs = step(steps, "songs")?.info as Record<string, number> | undefined;
  const popularity = step(steps, "popularity")?.info as
    | { mbids?: number; songs?: number; from_api?: number; api?: Record<string, unknown> }
    | undefined;
  const sel = step(steps, "select")?.info as
    | { pools?: { name: string; min: number; inTop: number; added: number; final: number }[] }
    | undefined;
  const load = step(steps, "load")?.info as Record<string, number> | undefined;
  const totalSeconds = steps.reduce((a, r) => a + r.seconds, 0);
  const out: string[] = [];
  out.push(`# Catalog report: ${m.catalog_version}

Generated by \`abtune catalog build\` (HANDOFF §6.8). Schema v${m.schema_version}, ${fmt(T)} tracks by ${fmt(s.artists)} artists,
digest \`${m.digest.slice(0, 16)}…\`. License: ${m.license.id} (see [DATA_LICENSES.md](DATA_LICENSES.md)).

Language scope: **Hebrew and English first** (owner decision, 2026-10-02). Other languages are in the catalog by
popularity but have no coverage quota or targeted checks yet.

## Sources

| source | dump date | files |
|---|---|---:|
${[...new Set(m.sources.map((x) => x.source))].map((src) => `| ${src} | ${m.sources.find((x) => x.source === src)?.dumpDate} | ${m.sources.filter((x) => x.source === src).length} |`).join("\n")}

Inputs as loaded: ${fmt(load?.recordings ?? 0)} MusicBrainz recordings, ${fmt(load?.canonical_redirects ?? 0)} canonical redirects,
${fmt(load?.lb_rows ?? 0)} ListenBrainz top-list rows from ${fmt(load?.lb_users ?? 0)} users, ${fmt(load?.ab_submissions ?? 0)} AcousticBrainz
submissions covering ${fmt(load?.ab_mbids ?? 0)} recording MBIDs.

## Pipeline counts

| step | count |
|---|---:|
| canonical recordings with listens | ${fmt(songs?.listened_canonicals ?? 0)} |
| listened canonical recordings merged into another (remasters, edits, feat. credits) | ${fmt(songs?.merged_canonicals ?? 0)} |
| other versions dropped (e.g. a less popular live take) | ${fmt(songs?.dropped_versions ?? 0)} |
| alternate versions kept (popular in their own right, e.g. iconic live takes) | ${fmt(songs?.kept_alt_versions ?? 0)} |
| songs after dedupe (artist + normalized title + version) | ${fmt(songs?.songs ?? 0)} |
| candidates (top by dump popularity + Hebrew pool) | ${fmt(cand?.candidates ?? 0)} |
${Object.entries(cand?.drops ?? {})
  .map(([k, v]) => `| dropped as non-music: ${k} | ${fmt(v)} |`)
  .join("\n")}
| ${popularity?.api?.enabled ? "MBIDs looked up in the ListenBrainz popularity API" : "MBIDs eligible for the popularity API (API off: dump-only ranking)"} | ${fmt(popularity?.mbids ?? 0)} |
| candidates ranked by API counts (rest by dump proxy) | ${fmt(popularity?.from_api ?? 0)} of ${fmt(popularity?.songs ?? 0)} |
| **catalog tracks** | **${fmt(T)}** |

${distTable("selected via", s.selectedVia, T)}
${(sel?.pools ?? []).map((p) => `Quota **${p.name}**: minimum ${fmt(p.min)}, ${fmt(p.inTop)} made the top ${fmt(T)} on popularity alone, ${fmt(p.added)} added; final ${fmt(p.final)}.`).join("\n")}

Listeners per track (ListenBrainz + MLHD+ where the API answered): min ${fmt(s.popularity.minListeners)}, median ${fmt(s.popularity.medianListeners)}, max ${fmt(s.popularity.maxListeners)}.

## Hits view

The songs people know (stage \`hits\`, owner decisions D2/D5). An international song is a hit when it is one of its
artist's top 3 (ranked by ListenBrainz users with the song in their all-time top 1000 and by the Various-Artists
compilations that carry it) and among the best-known of its decade. Israeli songs: the top 3 of each curated artist
(\`data/il_artists.yaml\`). Tier 1 is every other song by an artist with a hit; tier 2 is the rest.

| market | tier | tracks | share |
|---|---:|---:|---:|
${s.hits.tiers.map((t) => `| ${t.market} | ${t.tier} | ${fmt(t.n)} | ${pct(t.n, T)} |`).join("\n")}

${distTable(
  "hits view: decade",
  s.hits.decade,
  s.hits.tiers.filter((t) => t.tier === 0).reduce((a, t) => a + t.n, 0),
)}
${hitsNotes(step(steps, "hits")?.info)}
Signature songs, each artist's top 3 (tier 0 = in the hits view):

| artist | # | title | tier | top-list users | VA compilations |
|---|---:|---|---:|---:|---:|
${s.hits.signature.map((r) => `| ${r.artist} | ${r.rank} | ${r.title} | ${r.tier} | ${fmt(r.proxyListeners)} | ${fmt(r.vaComps)} |`).join("\n")}

## Feature coverage

${distTable("feature_source", s.featureSource, T)}
${distTable("genre_source", s.genreSource, T)}
ISRC coverage: ${fmt(s.isrc.withIsrc)} tracks (${pct(s.isrc.withIsrc, T)}) have at least one ISRC.

## Hebrew (IL) coverage

| measure | tracks | share of catalog |
|---|---:|---:|
| language = Hebrew | ${fmt(s.hebrew.lang)} | ${pct(s.hebrew.lang, T)} |
| artist country = IL | ${fmt(s.hebrew.country)} | ${pct(s.hebrew.country, T)} |
| Hebrew pool (either) | ${fmt(s.hebrew.pool)} | ${pct(s.hebrew.pool, T)} |
| Hebrew, artist not from IL | ${fmt(s.hebrew.langNotCountry)} | ${pct(s.hebrew.langNotCountry, T)} |
| IL artist, not Hebrew | ${fmt(s.hebrew.countryNotLang)} | ${pct(s.hebrew.countryNotLang, T)} |
| Hebrew pool with ISRC | ${fmt(s.isrc.hebrewWithIsrc)} | ${pct(s.isrc.hebrewWithIsrc, s.hebrew.pool)} of pool |

Top Hebrew-pool artists (sanity check):

| artist | tracks | max listeners |
|---|---:|---:|
${s.hebrew.topArtists.map((a) => `| ${a.artist} | ${fmt(a.tracks)} | ${fmt(a.listeners)} |`).join("\n")}

${distTable("Hebrew pool: primary cluster", s.hebrew.cluster, s.hebrew.pool, 15)}
${distTable("Hebrew pool: decade", s.hebrew.decade, s.hebrew.pool)}
${distTable("Hebrew pool: feature_source", s.hebrew.featureSource, s.hebrew.pool)}
## English coverage

English-language tracks: ${fmt(s.english.lang)} (${pct(s.english.lang, T)}).

${distTable("English: feature_source", s.english.featureSource, s.english.lang)}
${distTable("English: primary cluster", s.english.cluster, s.english.lang, 24)}
## Distributions

${distTable("decade", s.decade, T)}
${distTable("primary cluster", s.primaryCluster, T)}
${distTable("language", s.language, T)}
## Post-2022 music

${fmt(s.post2022.n)} tracks (${pct(s.post2022.n, T)}) were first released in 2023 or later; ${fmt(s.post2022.hebrew)} of them are in the Hebrew pool.
AcousticBrainz stopped in 2022, so these rely on siblings and the model:

${distTable("post-2022: feature_source", s.post2022.featureSource, s.post2022.n)}
## Imputation (tier 3, ridge regression)

`);
  if (imp) {
    out.push(`Trained on ${fmt(imp.trainRows)} tracks with AcousticBrainz data; λ chosen on ${fmt(imp.validationRows)} validation tracks.
Mean absolute error on the raw [-1, 1] scale, against predicting the training mean:

| dim | λ | MAE, random holdout (${fmt(imp.testRows)}) | baseline | MAE, unseen artists (${fmt(imp.artistTestRows)}) | baseline |
|---|---:|---:|---:|---:|---:|
${Object.entries(imp.dims)
  .map(
    ([d, r]) =>
      `| ${d} | ${r.lambda} | ${r.maeRandom.toFixed(3)} | ${r.baselineRandom.toFixed(3)} | ${r.maeArtist.toFixed(3)} | ${r.baselineArtist.toFixed(3)} |`,
  )
  .join("\n")}

"Unseen artists" holds out 5% of artists entirely (no artist or album means): the closest proxy for new and post-2022
artists, since there is no AcousticBrainz ground truth after 2022. ${fmt(imp.predicted)} catalog tracks use model features.

MAE by decade (random holdout):

| dim | ${Object.keys(Object.values(imp.dims)[0]?.maeByDecade ?? {}).join(" | ")} |
|---|${Object.keys(Object.values(imp.dims)[0]?.maeByDecade ?? {})
      .map(() => "---:")
      .join("|")}|
${Object.entries(imp.dims)
  .map(
    ([d, r]) =>
      `| ${d} | ${Object.values(r.maeByDecade)
        .map((v) => v.toFixed(3))
        .join(" | ")} |`,
  )
  .join("\n")}
`);
  }
  out.push(`
## Unmapped tags

The most common tags on catalog tracks that \`data/tag_map.yaml\` doesn't map (candidates for the next edit):

| tag | tracks | votes |
|---|---:|---:|
${s.unmappedTags.map((t) => `| ${t.tag} | ${fmt(t.songs)} | ${fmt(t.votes)} |`).join("\n")}

## Build time

| step | seconds | finished |
|---|---:|---|
${steps.map((r) => `| ${r.step} | ${r.seconds.toFixed(0)} | ${r.finishedAt.slice(0, 16).replace("T", " ")} |`).join("\n")}
| **total** | **${totalSeconds.toFixed(0)}** | |
`);
  return out.join("");
}
