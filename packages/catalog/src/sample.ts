// `abtune catalog sample`: the 50k dev sample and the 5k committed fixture, drawn deterministically
// from a built catalog (HANDOFF §6.1). Fixture ⊂ dev sample ⊂ full catalog; values are not recomputed.
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { canonicalJson } from "@abtune/engine";
import { CATALOG_COLUMNS, digestSql } from "./build/finalize.ts";
import { type Db, lit, pathLit } from "./db.ts";
import { sha256File } from "./files.ts";
import { type CatalogManifest, licenseText } from "./manifest.ts";
import { writeTar } from "./tar.ts";

interface Candidate {
  readonly id: string;
  readonly stratum: string;
  readonly hebrew: boolean;
}

/**
 * Pick k of m items ordered best-first: the top half outright, the rest evenly spaced over the
 * remainder, so a sample keeps both the hits and the long tail (the `mainstream` range).
 */
export function spreadPick(m: number, k: number): number[] {
  if (k >= m) return Array.from({ length: m }, (_, i) => i);
  if (k <= 0) return [];
  const top = Math.ceil(k / 2);
  const rest = k - top;
  const out = Array.from({ length: top }, (_, i) => i);
  for (let i = 0; i < rest; i++) out.push(top + Math.floor(((i + 0.5) * (m - top)) / rest));
  return out;
}

/** Largest-remainder allocation of `total` slots over sizes, at least one per non-empty group. */
export function allocate(sizes: readonly number[], total: number): number[] {
  const n = sizes.length;
  const base: number[] = sizes.map((s) => (s > 0 && total >= n ? 1 : 0));
  const left = total - base.reduce((a, b) => a + b, 0);
  const pool = sizes.map((s, i) => Math.max(0, s - (base[i] ?? 0)));
  const sum = pool.reduce((a, b) => a + b, 0);
  if (sum === 0 || left <= 0) return base;
  const exact = pool.map((s) => (s * left) / sum);
  const out = exact.map((x, i) => Math.min(pool[i] ?? 0, Math.floor(x)) + (base[i] ?? 0));
  let remaining = total - out.reduce((a, b) => a + b, 0);
  const order = exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i);
  for (const { i } of order) {
    if (remaining <= 0) break;
    if ((out[i] ?? 0) < (sizes[i] ?? 0)) {
      out[i] = (out[i] ?? 0) + 1;
      remaining--;
    }
  }
  return out;
}

/** Choose `size` track ids: a Hebrew floor first, then (primary cluster, decade) strata. */
export function chooseSample(
  ranked: readonly Candidate[],
  size: number,
  hebrewFloor: number,
): Set<string> {
  const chosen = new Set<string>();
  const hebrew = ranked.filter((c) => c.hebrew);
  for (const i of spreadPick(hebrew.length, Math.min(hebrewFloor, size))) {
    const c = hebrew[i];
    if (c) chosen.add(c.id);
  }
  const strata = new Map<string, Candidate[]>();
  for (const c of ranked) {
    if (chosen.has(c.id)) continue;
    const list = strata.get(c.stratum) ?? [];
    list.push(c);
    strata.set(c.stratum, list);
  }
  const keys = [...strata.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const slots = allocate(
    keys.map((k) => strata.get(k)?.length ?? 0),
    size - chosen.size,
  );
  keys.forEach((k, ki) => {
    const list = strata.get(k) ?? [];
    for (const i of spreadPick(list.length, slots[ki] ?? 0)) {
      const c = list[i];
      if (c) chosen.add(c.id);
    }
  });
  return chosen;
}

const HEBREW = "(language = 'lang_he' OR artist_country = 'IL')";

async function rankedCandidates(db: Db, table: string): Promise<Candidate[]> {
  return db.all<Candidate>(`
    SELECT track_id AS id, coalesce(primary_cluster, 'none') || '|' || coalesce(decade, 'unknown') AS stratum,
           ${HEBREW} AS hebrew
    FROM ${table} ORDER BY popularity_pct DESC, track_id`);
}

async function subset(db: Db, from: string, to: string, ids: Set<string>): Promise<void> {
  await db.run(`CREATE OR REPLACE TEMP TABLE sample_ids (track_id VARCHAR)`);
  const list = [...ids].sort();
  for (let i = 0; i < list.length; i += 5000) {
    await db.run(
      `INSERT INTO sample_ids VALUES ${list
        .slice(i, i + 5000)
        .map((id) => `(${lit(id)})`)
        .join(", ")}`,
    );
  }
  await db.run(
    `CREATE OR REPLACE TEMP TABLE ${to} AS SELECT * FROM ${from} SEMI JOIN sample_ids USING (track_id)`,
  );
}

export interface SampleResult {
  readonly devDir: string;
  readonly devTar: string;
  readonly devTarSha256: string;
  readonly fixtureDir: string;
  readonly devTracks: number;
  readonly fixtureTracks: number;
}

/** Fixture rows as canonical JSON lines (sorted by track_id), with tidy decimals. */
export async function fixtureLines(db: Db, table: string): Promise<string[]> {
  const rows = await db.all<Record<string, unknown>>(`
    SELECT ${CATALOG_COLUMNS.map((c) => (c === "clusters" ? "to_json(clusters)::VARCHAR AS clusters" : c)).join(", ")}
    FROM ${table} ORDER BY track_id`);
  const tidy = (v: unknown, dp: number) => (typeof v === "number" ? Number(v.toFixed(dp)) : v);
  return rows.map((r) => {
    const out: Record<string, unknown> = {};
    for (const c of CATALOG_COLUMNS) {
      const v = r[c];
      if (c === "clusters") {
        const parsed = JSON.parse(String(v ?? "{}")) as Record<string, number>;
        out[c] = Object.fromEntries(
          Object.entries(parsed).map(([k, w]) => [k, Number(w.toFixed(3))]),
        );
      } else if (c === "popularity_pct") out[c] = tidy(v, 6);
      else if (c === "raw_bpm") out[c] = tidy(v, 1);
      else if (typeof v === "number" && !Number.isInteger(v)) out[c] = tidy(v, 4);
      else out[c] = v;
    }
    return canonicalJson(out);
  });
}

export async function buildSamples(
  db: Db,
  opts: {
    readonly catalogDir: string;
    readonly outRoot: string;
    readonly fixtureDir: string;
    readonly devSize?: number;
    readonly fixtureSize?: number;
    readonly devHebrewFloor?: number;
    readonly fixtureHebrewFloor?: number;
  },
): Promise<SampleResult> {
  const {
    devSize = 50_000,
    fixtureSize = 5_000,
    devHebrewFloor = 1_000,
    fixtureHebrewFloor = 100,
  } = opts;
  const full = JSON.parse(
    await readFile(path.join(opts.catalogDir, "manifest.json"), "utf8"),
  ) as CatalogManifest;
  await db.run(
    `CREATE OR REPLACE TEMP TABLE full_catalog AS SELECT * FROM read_parquet(${pathLit(path.join(opts.catalogDir, "tracks.parquet"))})`,
  );

  const dev = chooseSample(await rankedCandidates(db, "full_catalog"), devSize, devHebrewFloor);
  await subset(db, "full_catalog", "dev_sample", dev);
  const fixture = chooseSample(
    await rankedCandidates(db, "dev_sample"),
    fixtureSize,
    fixtureHebrewFloor,
  );
  await subset(db, "dev_sample", "fixture_sample", fixture);

  const derived_from = {
    catalog_version: full.catalog_version,
    digest: full.digest,
    tracks: full.tracks,
  };
  const devName = `${full.catalog_version}-dev${devSize % 1000 === 0 ? `${devSize / 1000}k` : devSize}`;
  const devDir = path.join(opts.outRoot, devName);
  await mkdir(devDir, { recursive: true });
  const parquet = path.join(devDir, "tracks.parquet");
  await db.run(`COPY (SELECT ${CATALOG_COLUMNS.join(", ")} FROM dev_sample ORDER BY track_id)
                TO ${pathLit(parquet)} (FORMAT parquet, COMPRESSION zstd)`);
  const devManifest: CatalogManifest = {
    ...full,
    kind: "dev-sample",
    tracks: dev.size,
    digest: await db.value<string>(digestSql("dev_sample")),
    created_at: full.created_at,
    files: [
      {
        name: "tracks.parquet",
        bytes: (await readFile(parquet)).length,
        sha256: await sha256File(parquet),
      },
    ],
    derived_from,
  };
  const manifestText = `${JSON.stringify(devManifest, null, 2)}\n`;
  await writeFile(path.join(devDir, "manifest.json"), manifestText);
  await writeFile(path.join(devDir, "LICENSE.md"), licenseText(devManifest));

  // One uncompressed tar (Parquet is already compressed) + its sha256, for the GitHub release.
  const devTar = path.join(opts.outRoot, `${devName}.tar`);
  const tar = Buffer.concat([
    ...writeTar([
      { name: `${devName}/manifest.json`, data: Buffer.from(manifestText) },
      { name: `${devName}/LICENSE.md`, data: Buffer.from(licenseText(devManifest)) },
      { name: `${devName}/tracks.parquet`, data: await readFile(parquet) },
    ]),
  ]);
  await writeFile(devTar, tar);
  const devTarSha256 = createHash("sha256").update(tar).digest("hex");
  await writeFile(`${devTar}.sha256`, `${devTarSha256}  ${path.basename(devTar)}\n`);

  // The fixture: gzipped canonical JSON lines, committed to the repo.
  await mkdir(opts.fixtureDir, { recursive: true });
  const lines = await fixtureLines(db, "fixture_sample");
  const text = `${lines.join("\n")}\n`;
  const gz = gzipSync(Buffer.from(text), { level: 9 });
  // The digest covers the uncompressed text: gzip headers can differ by platform (OS byte).
  await writeFile(path.join(opts.fixtureDir, "tracks.jsonl.gz"), gz);
  const fixtureManifest: CatalogManifest = {
    ...full,
    kind: "fixture",
    tracks: lines.length,
    digest: createHash("sha256").update(text).digest("hex"),
    files: [
      {
        name: "tracks.jsonl.gz",
        bytes: gz.length,
        sha256: createHash("sha256").update(gz).digest("hex"),
      },
    ],
    derived_from,
  };
  await writeFile(
    path.join(opts.fixtureDir, "manifest.json"),
    `${JSON.stringify(fixtureManifest, null, 2)}\n`,
  );
  await writeFile(path.join(opts.fixtureDir, "LICENSE.md"), licenseText(fixtureManifest));
  return {
    devDir,
    devTar,
    devTarSha256,
    fixtureDir: opts.fixtureDir,
    devTracks: dev.size,
    fixtureTracks: lines.length,
  };
}
