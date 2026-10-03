// `abtune catalog build`: the full pipeline (HANDOFF §6.2), resumable stage by stage.
import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, type Dimensions, sha256Hex } from "@abtune/engine";
import {
  AB_DIMS,
  buildAbAggregates,
  buildRawDims,
  buildTier1,
  buildTier2,
} from "./build/features.ts";
import { buildCatalogTable, exportParquet } from "./build/finalize.ts";
import { buildCandidates, buildFilters, buildGenres, type Pool } from "./build/genres.ts";
import { buildHits, DEFAULT_HITS, type HitsConfig } from "./build/hits.ts";
import {
  loadAcousticBrainz,
  loadCanonical,
  loadDimensions,
  loadListenBrainz,
  loadMusicBrainz,
  loadTagMap,
} from "./build/load.ts";
import { apiQueryMbids, buildSelection, buildSongPopularity } from "./build/select.ts";
import { buildAttributes, buildSongs, type DedupeConfig, poolSeeds } from "./build/songs.ts";
import { Db } from "./db.ts";
import { readLock } from "./download.ts";
import { extractAll, rawPaths } from "./extract/index.ts";
import { sha256File } from "./files.ts";
import { DEFAULT_IL_ARTISTS, type IlArtists, loadIlArtists } from "./il-artists.ts";
import { impute } from "./impute.ts";
import {
  CATALOG_LICENSE,
  CATALOG_SCHEMA_VERSION,
  type CatalogManifest,
  licenseText,
} from "./manifest.ts";
import { CACHE_FILE, fetchPopularity } from "./popularity-api.ts";
import { collectStats, renderReport } from "./report.ts";
import type { SourcesLock } from "./sources.ts";
import { buildLayout, type Layout, type Log, runStep, type StepRecord } from "./steps.ts";
import { loadTagMap as readTagMap, type TagMap } from "./tagmap.ts";

export interface BuildConfig {
  /** e.g. "catalog-2026.10". */
  readonly version: string;
  /** Final catalog size (§6.1: ~2M). */
  readonly target: number;
  /** Candidates (by dump popularity) that get genres, filters and API counts. */
  readonly candidates: number;
  /** Coverage quotas (§6.2 stage 3). */
  readonly pools: readonly Pool[];
  readonly dedupe: DedupeConfig;
  /** Top up popularity from the ListenBrainz API (otherwise dump-only). */
  readonly api: boolean;
  readonly minLengthMs: number;
  /** The hits view (owner decisions D2/D5). */
  readonly hits: HitsConfig;
}

export const DEFAULT_CONFIG: Omit<BuildConfig, "version"> = {
  target: 2_000_000,
  candidates: 3_500_000,
  // Hebrew + English first (owner, 2026-10-02); other language pools are deferred. "he" (IL artist
  // or Hebrew) fills mostly with Israeli psytrance/EDM, which has a global audience, so a
  // Hebrew-language quota follows: every Hebrew song with >= 2 known listeners (owner, 2026-10-02).
  pools: [
    { name: "he", countries: ["IL"], languages: ["heb"], script: "Hebrew", min: 30_000 },
    { name: "he_lang", countries: [], languages: ["heb"], min: 18_000 },
  ],
  dedupe: { minListeners: 20, minShare: 0.2 },
  api: true,
  minLengthMs: 30_000,
  hits: DEFAULT_HITS,
};

export interface BuildOptions {
  readonly config: BuildConfig;
  readonly dims: Dimensions;
  readonly layout?: Layout;
  readonly tagMapFile?: string;
  /** The curated Israeli artists (default data/il_artists.yaml; missing = not curated yet). */
  readonly ilArtistsFile?: string;
  /** Re-run this stage and everything after it. */
  readonly fromStage?: Stage;
  readonly memoryLimit?: string;
  readonly threads?: number;
  /** Directory for the API popularity snapshot (default: <dumps>/lb-popularity-api). */
  readonly apiCacheDir?: string;
  readonly fetchImpl?: typeof fetch;
  /** Where to write the Markdown report (default: docs/catalog-report-<version>.md). */
  readonly reportFile?: string;
  readonly log: Log;
}

export const STAGES = [
  "load",
  "songs",
  "candidates",
  "popularity",
  "select",
  "features",
  "hits",
  "export",
] as const;
export type Stage = (typeof STAGES)[number];

export interface BuildResult {
  readonly manifest: CatalogManifest;
  readonly steps: readonly StepRecord[];
  readonly outDir: string;
  readonly reportFile: string;
}

/** Bump when stage SQL changes in a way that should invalidate existing stamps. */
export const PIPELINE_VERSION = 3;

export async function buildCatalog(opts: BuildOptions): Promise<BuildResult> {
  const { config, dims, log } = opts;
  const layout = opts.layout ?? buildLayout({ version: config.version });
  const lock = await readLock(layout.dumps);
  if (!lock)
    throw new Error(`No ${layout.dumps}/sources.lock.json: run \`abtune catalog download\` first.`);
  const tagMap = await readTagMap(opts.tagMapFile, dims);
  const ilArtists = await loadIlArtists(opts.ilArtistsFile ?? DEFAULT_IL_ARTISTS);
  const apiCacheDir = opts.apiCacheDir ?? path.join(layout.dumps, "lb-popularity-api");

  const extractSteps = await extractAll(lock, layout.dumps, layout.raw, log);
  await mkdir(layout.work, { recursive: true });
  const db = await Db.open(path.join(layout.work, "build.duckdb"), {
    memoryLimit: opts.memoryLimit,
    threads: opts.threads,
    tempDir: path.join(layout.work, "tmp"),
  });
  try {
    await loadTagMap(db, tagMap.file);
    await loadDimensions(db, dims);
    const steps = await runStages(db, opts, layout, lock, tagMap, ilArtists, apiCacheDir);
    const manifest = JSON.parse(
      await readFile(path.join(layout.out, "manifest.json"), "utf8"),
    ) as CatalogManifest;
    const all = [...extractSteps, ...steps];
    const stats = await collectStats(db);
    const reportFile =
      opts.reportFile ??
      path.join("docs", `catalog-report-${config.version.replace(/^catalog-/, "")}.md`);
    await writeFile(
      path.join(layout.out, "build-stats.json"),
      `${JSON.stringify({ stats, steps: all }, null, 2)}\n`,
    );
    await mkdir(path.dirname(reportFile), { recursive: true });
    await writeFile(reportFile, renderReport({ manifest, stats, steps: all }));
    log(`Report: ${reportFile}`);
    return { manifest, steps: all, outDir: layout.out, reportFile };
  } finally {
    db.close();
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

async function runStages(
  db: Db,
  opts: BuildOptions,
  layout: Layout,
  lock: SourcesLock,
  tagMap: TagMap,
  ilArtists: IlArtists,
  apiCacheDir: string,
): Promise<StepRecord[]> {
  const { config, dims, log } = opts;
  const stamps = path.join(layout.work, ".stamps");
  const raw = layout.raw;
  const forceFrom = opts.fromStage ? STAGES.indexOf(opts.fromStage) : STAGES.length;
  const tagHash = sha256Hex(tagMap.text);
  const dimsHash = sha256Hex(canonicalJson(dims));
  const records: StepRecord[] = [];
  let prev = sha256Hex(
    canonicalJson({ v: PIPELINE_VERSION, lock: lock.files.map((f) => f.sha256) }),
  );
  const stage = async (
    name: Stage,
    inputs: unknown,
    fn: () => Promise<Record<string, unknown>>,
  ) => {
    const rec = await runStep(
      stamps,
      name,
      { prev, inputs },
      fn,
      log,
      STAGES.indexOf(name) >= forceFrom,
    );
    records.push(rec);
    prev = rec.inputs;
    return rec;
  };

  await stage("load", { raw: rawPaths(raw).stamps }, async () => {
    await loadMusicBrainz(db, raw);
    await loadCanonical(db, raw);
    await loadListenBrainz(db, raw);
    await loadAcousticBrainz(db, raw);
    return db.one(`SELECT (SELECT count(*) FROM mb_recording) AS recordings, (SELECT count(*) FROM lb_rec) AS lb_rows,
      (SELECT count(DISTINCT user_id) FROM lb_rec) AS lb_users, (SELECT count(*) FROM ab_hl) AS ab_submissions,
      (SELECT count(DISTINCT mbid) FROM ab_hl) AS ab_mbids, (SELECT count(*) FROM cn_rec) AS canonical_redirects`);
  });

  await stage(
    "songs",
    { dedupe: config.dedupe, seeds: poolSeeds(config.pools), minLen: config.minLengthMs },
    async () => {
      await buildSongs(db, config.dedupe, config.pools, config.minLengthMs);
      await buildAttributes(db);
      return db.one(`SELECT (SELECT count(*) FROM canon_pop) AS listened_canonicals, (SELECT count(*) FROM canon_info) AS keyed_canonicals,
      (SELECT count(*) FROM unit_pop) AS units, (SELECT count(*) FROM song) AS songs,
      (SELECT count(*) FROM song WHERE alt_version) AS kept_alt_versions,
      (SELECT count(*) FROM canon_pop) - (SELECT count(*) FROM unit_pop WHERE listeners > 0) AS merged_canonicals,
      (SELECT count(*) FROM unit_pop) - (SELECT count(*) FROM song) AS dropped_versions,
      (SELECT count(*) FROM song WHERE proxy_listeners = 0) AS seeded_songs`);
    },
  );

  await stage(
    "candidates",
    { n: config.candidates, pools: config.pools, minLen: config.minLengthMs, tagHash, dimsHash },
    async () => {
      await buildCandidates(db, config.candidates, config.pools);
      await buildAbAggregates(db);
      await buildTier1(db);
      await buildGenres(db);
      await buildFilters(db, config.minLengthMs);
      const drops = await db.all<{ reason: string; n: number }>(
        `SELECT reason, count(*) AS n FROM cand_drop WHERE reason IS NOT NULL GROUP BY reason ORDER BY reason`,
      );
      return {
        ...(await db.one(
          `SELECT (SELECT count(*) FROM cand) AS candidates, (SELECT count(*) FROM song_ab) AS with_ab`,
        )),
        drops: Object.fromEntries(drops.map((d) => [d.reason, d.n])),
      };
    },
  );

  await stage(
    "popularity",
    { api: config.api, cache: config.api ? apiCacheDir : null },
    async () => {
      const mbids = await apiQueryMbids(db);
      let api: Record<string, unknown> = { enabled: false };
      if (config.api) {
        api = {
          enabled: true,
          ...(await fetchPopularity(mbids, {
            cacheDir: apiCacheDir,
            fetchImpl: opts.fetchImpl,
            log,
          })),
        };
      }
      const cacheFile = path.join(apiCacheDir, CACHE_FILE);
      await buildSongPopularity(
        db,
        config.api && (await exists(cacheFile)) ? cacheFile : undefined,
      );
      return {
        mbids: mbids.length,
        api,
        ...(await db.one(
          `SELECT count(*) AS songs, count(*) FILTER (WHERE from_api) AS from_api FROM song_pop`,
        )),
      };
    },
  );

  await stage("select", { target: config.target, pools: config.pools }, async () => ({
    ...(await buildSelection(db, config.target, config.pools)),
  }));

  await stage("features", {}, async () => {
    await buildTier2(db);
    await buildRawDims(db);
    const report = await impute(db, AB_DIMS, dims.genres, dims.decades, log);
    return { impute: report as unknown as Record<string, unknown> };
  });

  const ilHash = sha256Hex(ilArtists.text);
  await stage("hits", { hits: config.hits, il: ilHash }, async () =>
    buildHits(db, config.hits, ilArtists),
  );

  await stage(
    "export",
    { version: config.version, schema: CATALOG_SCHEMA_VERSION, tagHash },
    async () => {
      await buildCatalogTable(db, config.version);
      await mkdir(layout.out, { recursive: true });
      const tracksFile = path.join(layout.out, "tracks.parquet");
      const { bytes, digest } = await exportParquet(db, "catalog", tracksFile);
      const tracks = await db.value<number>(`SELECT count(*) FROM catalog`);
      const manifest: CatalogManifest = {
        name: "abtune-catalog",
        catalog_version: config.version,
        schema_version: CATALOG_SCHEMA_VERSION,
        kind: "full",
        tracks,
        digest,
        created_at: new Date().toISOString(),
        license: CATALOG_LICENSE,
        sources: lock.files.map((f) => ({
          source: f.source,
          url: f.url,
          sha256: f.sha256,
          dumpDate: f.dumpDate,
        })),
        popularity: { api: config.api, snapshot: config.api ? path.basename(apiCacheDir) : null },
        config: { ...config, tag_map_sha256: tagHash, il_artists_sha256: ilHash },
        dimensions: { genres: dims.genres, decades: dims.decades, languages: dims.languages },
        files: [{ name: "tracks.parquet", bytes, sha256: await sha256File(tracksFile) }],
      };
      await writeFile(
        path.join(layout.out, "manifest.json"),
        `${JSON.stringify(manifest, null, 2)}\n`,
      );
      await writeFile(path.join(layout.out, "LICENSE.md"), licenseText(manifest));
      return { tracks, bytes, digest };
    },
  );
  return records;
}

export { Db } from "./db.ts";
export { draftIlArtists, renderIlArtists } from "./il-artists.ts";
export { buildSamples, type SampleResult } from "./sample.ts";
