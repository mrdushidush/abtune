// Build directories and resumable steps: a step reruns only when its inputs change.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { canonicalJson, sha256Hex } from "@abtune/engine";

export interface Layout {
  /** Downloaded dumps + sources.lock.json. */
  readonly dumps: string;
  /** Extracted raw tables, shared by every catalog version built from the same dumps. */
  readonly raw: string;
  /** Per-version scratch: build.duckdb, DuckDB temp files. */
  readonly work: string;
  /** Final catalog directory (tracks.parquet, manifest.json, LICENSE.md). */
  readonly out: string;
}

export function buildLayout(opts: {
  readonly version: string;
  readonly dumps?: string;
  readonly buildDir?: string;
  readonly outDir?: string;
}): Layout {
  const buildDir = opts.buildDir ?? "data/build";
  return {
    dumps: opts.dumps ?? "data/dumps",
    raw: path.join(buildDir, "raw"),
    work: path.join(buildDir, opts.version),
    out: path.join(opts.outDir ?? "data/catalog", opts.version),
  };
}

export interface StepRecord {
  readonly step: string;
  readonly inputs: string;
  readonly seconds: number;
  readonly finishedAt: string;
  readonly info: Record<string, unknown>;
}

export type Log = (line: string) => void;

/**
 * Run `fn` unless a stamp in `stampDir` shows it already finished with identical inputs.
 * Returns the step's info (fresh or from the stamp).
 */
export async function runStep(
  stampDir: string,
  step: string,
  inputs: unknown,
  fn: () => Promise<Record<string, unknown>>,
  log: Log,
  force = false,
): Promise<StepRecord> {
  const stamp = path.join(stampDir, `${step}.json`);
  const hash = sha256Hex(canonicalJson(inputs));
  if (!force) {
    try {
      const prev = JSON.parse(await readFile(stamp, "utf8")) as StepRecord;
      if (prev.inputs === hash) {
        log(
          `· ${step}: up to date (${prev.seconds.toFixed(0)}s on ${prev.finishedAt.slice(0, 16)})`,
        );
        return prev;
      }
    } catch {}
  }
  await rm(stamp, { force: true });
  log(`▶ ${step}`);
  const started = performance.now();
  const info = await fn();
  const record: StepRecord = {
    step,
    inputs: hash,
    seconds: (performance.now() - started) / 1000,
    finishedAt: new Date().toISOString(),
    info,
  };
  await mkdir(stampDir, { recursive: true });
  await writeFile(stamp, `${JSON.stringify(record, null, 2)}\n`);
  log(`✓ ${step} (${record.seconds.toFixed(1)}s)`);
  return record;
}

/** All step records in a stamp directory (for the report's timing table). */
export async function readStepRecords(
  stampDir: string,
  steps: readonly string[],
): Promise<StepRecord[]> {
  const out: StepRecord[] = [];
  for (const step of steps) {
    try {
      out.push(
        JSON.parse(await readFile(path.join(stampDir, `${step}.json`), "utf8")) as StepRecord,
      );
    } catch {}
  }
  return out;
}
