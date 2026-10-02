import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadBankFromDisk } from "@abtune/bank/node";
import { downloadAll, fetchSample, readLock, resolveSources, writeLock } from "@abtune/catalog";
import type { Dimensions } from "@abtune/engine";

export const catalogHelp = `abtune catalog <subcommand> [options]

Build the open-data music catalog (HANDOFF §6), or fetch the prebuilt dev sample.

Subcommands:
  download [--dir data/dumps] [--refresh] [--concurrency 3]
      Download the MusicBrainz, ListenBrainz and AcousticBrainz dumps (~72 GB).
      Resumable and sha256-verified. Versions are pinned in <dir>/sources.lock.json;
      --refresh re-resolves the newest dumps.

  build [--version catalog-YYYY.MM] [--target 2000000] [--candidates 3500000]
        [--he-min 30000] [--he-lang-min 18000] [--no-api] [--from-stage <stage>]
        [--memory 16GB] [--threads N]
      Run the pipeline: extract → load → songs → candidates → popularity → select →
      features → export. Writes data/catalog/<version>/ and docs/catalog-report-*.md.
      --he-min is the quota for IL artists or Hebrew songs; --he-lang-min for Hebrew songs.
      Needs ~60 GB free disk besides the dumps. Each stage resumes when its inputs
      are unchanged; --from-stage reruns a stage and everything after it.

  sample [--catalog data/catalog/<version>] [--dev-size 50000] [--fixture-size 5000]
      Draw the dev sample (data/catalog/<version>-dev50k/ plus a .tar for release) and
      the committed 5k test fixture (data/catalog-fixture/) from a built catalog.

  fetch [--file <tar> | --url <url>] [--out data/catalog]
      Download (default: CATALOG_SAMPLE_URL or the GitHub release), verify and install
      the prebuilt dev sample. Needs neither the dumps nor DuckDB.

  report [--catalog data/catalog/<version>] [--out docs/catalog-report-<v>.md]
      Re-render the data quality report from a build's build-stats.json.`;

export async function catalog(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "download":
      return download(rest);
    case "build":
      return build(rest);
    case "sample":
      return sample(rest);
    case "fetch":
      return fetchCmd(rest);
    case "report":
      return report(rest);
    default:
      console.error(sub ? `Unknown subcommand "${sub}".\n\n${catalogHelp}` : catalogHelp);
      return 1;
  }
}

const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

async function download(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      dir: { type: "string", default: "data/dumps" },
      refresh: { type: "boolean", default: false },
      concurrency: { type: "string", default: "3" },
    },
  });
  let lock = values.refresh ? undefined : await readLock(values.dir);
  if (lock) {
    log(`Using pinned sources from ${values.dir}/sources.lock.json (resolved ${lock.resolvedAt})`);
  } else {
    log("Resolving the newest dumps…");
    lock = await resolveSources();
    await writeLock(values.dir, lock);
  }
  for (const f of lock.files) log(`  ${f.source.padEnd(12)} ${f.dumpDate}  ${f.path}`);
  await downloadAll(lock, { dir: values.dir, concurrency: Number(values.concurrency), log });
  return 0;
}

async function bankDimensions(): Promise<Dimensions | undefined> {
  const bank = await loadBankFromDisk();
  if (!bank.bank || bank.errors > 0) {
    console.error("abtune catalog: the question bank has errors; run `abtune lint`.");
    return undefined;
  }
  return bank.bank.dimensions;
}

async function build(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      version: { type: "string" },
      dumps: { type: "string", default: "data/dumps" },
      target: { type: "string" },
      candidates: { type: "string" },
      "he-min": { type: "string" },
      "he-lang-min": { type: "string" },
      "no-api": { type: "boolean", default: false },
      "from-stage": { type: "string" },
      memory: { type: "string" },
      threads: { type: "string" },
    },
  });
  // The heavy pipeline (DuckDB) loads only for this subcommand.
  const { buildCatalog, DEFAULT_CONFIG, STAGES } = await import("@abtune/catalog/build");
  const { buildLayout } = await import("@abtune/catalog");
  const dims = await bankDimensions();
  if (!dims) return 1;
  const lock = await readLock(values.dumps);
  if (!lock) {
    console.error(`No ${values.dumps}/sources.lock.json: run \`abtune catalog download\` first.`);
    return 1;
  }
  const mbDate =
    lock.files.find((f) => f.source === "mb-core")?.dumpDate ?? new Date().toISOString();
  const version = values.version ?? `catalog-${mbDate.slice(0, 4)}.${mbDate.slice(5, 7)}`;
  const fromStage = values["from-stage"];
  if (fromStage !== undefined && !(STAGES as readonly string[]).includes(fromStage)) {
    console.error(`--from-stage must be one of: ${STAGES.join(", ")}`);
    return 1;
  }
  const minOverride: Record<string, string | undefined> = {
    he: values["he-min"],
    he_lang: values["he-lang-min"],
  };
  const config = {
    ...DEFAULT_CONFIG,
    version,
    ...(values.target ? { target: Number(values.target) } : {}),
    ...(values.candidates ? { candidates: Number(values.candidates) } : {}),
    pools: DEFAULT_CONFIG.pools.map((p) => {
      const min = minOverride[p.name];
      return min === undefined ? p : { ...p, min: Number(min) };
    }),
    api: !values["no-api"],
  };
  const started = performance.now();
  const result = await buildCatalog({
    config,
    dims,
    layout: buildLayout({ version, dumps: values.dumps }),
    fromStage: fromStage as (typeof STAGES)[number] | undefined,
    memoryLimit: values.memory,
    threads: values.threads ? Number(values.threads) : undefined,
    log,
  });
  log(
    `✓ ${result.manifest.catalog_version}: ${result.manifest.tracks.toLocaleString("en")} tracks in ${result.outDir} ` +
      `(${((performance.now() - started) / 60000).toFixed(1)} min)`,
  );
  return 0;
}

/** The newest full catalog under data/catalog (by name), unless --catalog says otherwise. */
async function defaultCatalogDir(): Promise<string | undefined> {
  const { readdir } = await import("node:fs/promises");
  try {
    const dirs = (await readdir("data/catalog", { withFileTypes: true }))
      .filter((d) => d.isDirectory() && /^catalog-\d{4}\.\d{2}$/.test(d.name))
      .map((d) => d.name)
      .sort();
    const last = dirs.at(-1);
    return last ? path.join("data/catalog", last) : undefined;
  } catch {
    return undefined;
  }
}

async function sample(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      catalog: { type: "string" },
      "dev-size": { type: "string", default: "50000" },
      "fixture-size": { type: "string", default: "5000" },
      "fixture-dir": { type: "string", default: "data/catalog-fixture" },
    },
  });
  const catalogDir = values.catalog ?? (await defaultCatalogDir());
  if (!catalogDir) {
    console.error("No built catalog found; pass --catalog or run `abtune catalog build`.");
    return 1;
  }
  const { Db, buildSamples } = await import("@abtune/catalog/build");
  const started = performance.now();
  const db = await Db.open(":memory:");
  try {
    const r = await buildSamples(db, {
      catalogDir,
      outRoot: path.dirname(catalogDir),
      fixtureDir: values["fixture-dir"],
      devSize: Number(values["dev-size"]),
      fixtureSize: Number(values["fixture-size"]),
    });
    log(`Dev sample: ${r.devTracks.toLocaleString("en")} tracks in ${r.devDir}`);
    log(`Release asset: ${r.devTar} (sha256 ${r.devTarSha256})`);
    log(`Fixture: ${r.fixtureTracks.toLocaleString("en")} tracks in ${r.fixtureDir}`);
  } finally {
    db.close();
  }
  log(`Done in ${((performance.now() - started) / 1000).toFixed(1)}s`);
  return 0;
}

async function fetchCmd(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      file: { type: "string" },
      url: { type: "string" },
      out: { type: "string", default: "data/catalog" },
    },
  });
  const started = performance.now();
  const { dir } = await fetchSample({
    file: values.file,
    url: values.url,
    outRoot: values.out,
    log,
  });
  log(
    `Ready in ${((performance.now() - started) / 1000).toFixed(1)}s. Set CATALOG_PATH=${dir.split(path.sep).join("/")} (or leave it unset to use the newest catalog in ${values.out}).`,
  );
  return 0;
}

async function report(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { catalog: { type: "string" }, out: { type: "string" } },
  });
  const catalogDir = values.catalog ?? (await defaultCatalogDir());
  if (!catalogDir) {
    console.error("No built catalog found; pass --catalog.");
    return 1;
  }
  const { renderReport } = await import("@abtune/catalog/report");
  const manifest = JSON.parse(await readFile(path.join(catalogDir, "manifest.json"), "utf8"));
  const { stats, steps } = JSON.parse(
    await readFile(path.join(catalogDir, "build-stats.json"), "utf8"),
  );
  const out =
    values.out ??
    path.join(
      "docs",
      `catalog-report-${String(manifest.catalog_version).replace(/^catalog-/, "")}.md`,
    );
  await writeFile(out, renderReport({ manifest, stats, steps }));
  log(`Report: ${out}`);
  return 0;
}
