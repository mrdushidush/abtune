// AcousticBrainz high-level dump → one TSV row per submission (HANDOFF §6.3 inputs).
// 30 archives × ~1M JSON files each; parsed in worker threads, never unpacked to disk.

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { cpus } from "node:os";
import { Worker } from "node:worker_threads";
import { openTar } from "../archive.ts";

/** classifier → class probabilities we keep, in TSV column order after (mbid, submission). */
export const AB_CLASSIFIERS = {
  danceability: ["danceable"],
  mood_happy: ["happy"],
  mood_sad: ["sad"],
  mood_relaxed: ["relaxed"],
  mood_party: ["party"],
  mood_aggressive: ["aggressive"],
  mood_acoustic: ["acoustic"],
  mood_electronic: ["electronic"],
  voice_instrumental: ["voice"],
  genre_dortmund: [
    "alternative",
    "blues",
    "electronic",
    "folkcountry",
    "funksoulrnb",
    "jazz",
    "pop",
    "raphiphop",
    "rock",
  ],
  genre_rosamerica: ["cla", "dan", "hip", "jaz", "pop", "rhy", "roc", "spe"],
} as const satisfies Record<string, readonly string[]>;

/** TSV column names: mbid, submission, then `<classifier>__<class>`. */
export const AB_HL_COLUMNS: readonly string[] = [
  "mbid",
  "submission",
  ...Object.entries(AB_CLASSIFIERS).flatMap(([c, classes]) => classes.map((k) => `${c}__${k}`)),
];

const NAME = /(?:^|\/)highlevel\/[0-9a-f]{2}\/[0-9a-f]\/([0-9a-f-]{36})-(\d+)\.json$/;

type Highlevel = Record<string, { all?: Record<string, number> } | undefined>;

/** One TSV line (no newline) for a high-level document, or undefined if a classifier is missing. */
export function highlevelRow(
  mbid: string,
  submission: number,
  doc: { highlevel?: Highlevel },
): string | undefined {
  const hl = doc.highlevel;
  if (!hl) return undefined;
  const cells: string[] = [mbid, String(submission)];
  for (const [classifier, classes] of Object.entries(AB_CLASSIFIERS)) {
    const all = hl[classifier]?.all;
    for (const k of classes) {
      const p = all?.[k];
      if (typeof p !== "number" || !Number.isFinite(p)) return undefined;
      // 5 decimals is far below classifier noise and keeps the TSV small.
      cells.push(String(Math.round(Math.min(1, Math.max(0, p)) * 1e5) / 1e5));
    }
  }
  return cells.join("\t");
}

export interface PartResult {
  readonly docs: number;
  readonly rows: number;
  readonly skipped: number;
}

/** Convert one high-level archive to TSV (runs inside a worker). */
export async function convertHighlevelPart(archive: string, outFile: string): Promise<PartResult> {
  const out = createWriteStream(outFile);
  let docs = 0;
  let rows = 0;
  let skipped = 0;
  let pending: string[] = [];
  const flush = async () => {
    if (pending.length === 0) return;
    const ok = out.write(`${pending.join("\n")}\n`);
    pending = [];
    if (!ok) await once(out, "drain");
  };
  for await (const entry of openTar(archive)) {
    const m = NAME.exec(entry.name);
    if (!m?.[1] || entry.type !== "file") continue;
    docs++;
    let row: string | undefined;
    try {
      row = highlevelRow(m[1], Number(m[2]), JSON.parse((await entry.buffer()).toString("utf8")));
    } catch {
      row = undefined;
    }
    if (row === undefined) skipped++;
    else {
      pending.push(row);
      rows++;
      if (pending.length >= 5000) await flush();
    }
  }
  await flush();
  out.end();
  await once(out, "finish");
  return { docs, rows, skipped };
}

/** Convert all parts with a worker pool; results in input order. */
export async function convertHighlevelParts(
  jobs: readonly { archive: string; out: string }[],
  log: (line: string) => void,
  workers = Math.max(1, Math.min(jobs.length, cpus().length - 2)),
): Promise<PartResult[]> {
  const results: PartResult[] = new Array(jobs.length);
  let next = 0;
  const run = async () => {
    while (next < jobs.length) {
      const i = next++;
      const job = jobs[i];
      if (!job) break;
      const worker = new Worker(new URL("./ab-worker.ts", import.meta.url), { workerData: job });
      const [result] = (await once(worker, "message")) as [PartResult | { error: string }];
      await worker.terminate();
      if ("error" in result) throw new Error(`${job.archive}: ${result.error}`);
      results[i] = result;
      log(
        `  AB part ${i + 1}/${jobs.length}: ${result.rows.toLocaleString("en")} rows (${result.skipped} skipped)`,
      );
    }
  };
  await Promise.all(Array.from({ length: workers }, run));
  return results;
}
