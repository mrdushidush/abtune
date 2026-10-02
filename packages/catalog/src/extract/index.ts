// Stage 1: extract what the build needs from each dump into data/build/raw (HANDOFF §6.2).

import { once } from "node:events";
import { createWriteStream } from "node:fs";
import { mkdir, open, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { assertLicense, extractWithSystemTar, openTar } from "../archive.ts";
import { localPath } from "../download.ts";
import { MB_SCHEMA_SEQUENCE, MB_TABLES } from "../mb-schema.ts";
import type { LockedFile, SourceId, SourcesLock } from "../sources.ts";
import { type Log, runStep, type StepRecord } from "../steps.ts";
import { convertHighlevelParts } from "./ab.ts";

/** Where each extracted input lives under the raw directory. */
export const rawPaths = (raw: string) => ({
  mbTable: (dump: "core" | "derived", table: string) => path.join(raw, "mb", dump, "mbdump", table),
  canonicalRecording: path.join(raw, "canonical", "canonical_recording_redirect.csv"),
  canonicalRelease: path.join(raw, "canonical", "canonical_release_redirect.csv"),
  lbRecordings: path.join(raw, "lbstats", "recordings_all_time.tsv"),
  abHighlevel: (part: number) => path.join(raw, "ab", `hl-${String(part).padStart(2, "0")}.tsv`),
  abHighlevelGlob: path.join(raw, "ab", "hl-*.tsv"),
  abRhythm: path.join(raw, "ab", "rhythm.csv"),
  stamps: path.join(raw, ".stamps"),
});

function filesOf(lock: SourcesLock, source: SourceId): LockedFile[] {
  const files = lock.files.filter((f) => f.source === source);
  if (files.length === 0) throw new Error(`sources.lock.json has no ${source} files`);
  return files;
}

function one(lock: SourcesLock, source: SourceId): LockedFile {
  return filesOf(lock, source)[0] as LockedFile;
}

async function firstLine(file: string): Promise<string | undefined> {
  const fh = await open(file);
  try {
    const buf = Buffer.alloc(64 * 1024);
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    if (bytesRead === 0) return undefined;
    const text = buf.subarray(0, bytesRead).toString("utf8");
    const nl = text.indexOf("\n");
    return nl === -1 ? text : text.slice(0, nl);
  } finally {
    await fh.close();
  }
}

export async function extractMusicBrainz(
  lock: SourcesLock,
  dumps: string,
  raw: string,
): Promise<Record<string, unknown>> {
  const paths = rawPaths(raw);
  const info: Record<string, unknown> = {};
  for (const dump of ["core", "derived"] as const) {
    const file = one(lock, dump === "core" ? "mb-core" : "mb-derived");
    const outDir = path.join(raw, "mb", dump);
    await rm(outDir, { recursive: true, force: true });
    const tables = MB_TABLES.filter((t) => t.dump === dump);
    const members = ["COPYING", "SCHEMA_SEQUENCE", ...tables.map((t) => `mbdump/${t.name}`)];
    const { missing } = await extractWithSystemTar(localPath(dumps, file), members, outDir);
    if (missing.length > 0) throw new Error(`${file.path} lacks ${missing.join(", ")}`);
    assertLicense(
      await readFile(path.join(outDir, "COPYING"), "utf8"),
      dump === "core" ? "CC0-1.0" : "CC-BY-NC-SA-3.0-US",
      file.path,
    );
    const seq = Number((await readFile(path.join(outDir, "SCHEMA_SEQUENCE"), "utf8")).trim());
    if (seq !== MB_SCHEMA_SEQUENCE) {
      throw new Error(
        `${file.path} is MusicBrainz schema ${seq}; the catalog knows schema ${MB_SCHEMA_SEQUENCE}. ` +
          "Update packages/catalog/src/mb-schema.ts from admin/sql/CreateTables.sql.",
      );
    }
    for (const t of tables) {
      const line = await firstLine(paths.mbTable(dump, t.name));
      const cols = line === undefined ? t.columns.length : line.split("\t").length;
      if (cols !== t.columns.length) {
        throw new Error(
          `mbdump/${t.name} has ${cols} columns, expected ${t.columns.length} (schema ${seq})`,
        );
      }
    }
    info[dump] = { schemaSequence: seq, tables: tables.length };
  }
  return info;
}

async function writeEntry(entry: { stream(): AsyncIterable<Buffer> }, file: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const out = createWriteStream(file);
  for await (const chunk of entry.stream()) {
    if (!out.write(chunk)) await once(out, "drain");
  }
  out.end();
  await once(out, "finish");
}

export async function extractCanonical(
  lock: SourcesLock,
  dumps: string,
  raw: string,
): Promise<Record<string, unknown>> {
  const file = one(lock, "canonical");
  const paths = rawPaths(raw);
  const wanted = new Map([
    ["canonical/canonical_recording_redirect.csv", paths.canonicalRecording],
    ["canonical/canonical_release_redirect.csv", paths.canonicalRelease],
  ]);
  let licensed = false;
  for await (const entry of openTar(localPath(dumps, file))) {
    const rel = entry.name.split("/").slice(1).join("/"); // drop the top-level dump directory
    if (rel === "COPYING") {
      assertLicense((await entry.buffer()).toString("utf8"), "CC0-1.0", file.path);
      licensed = true;
    }
    const target = wanted.get(rel);
    if (target) {
      await writeEntry(entry, target);
      wanted.delete(rel);
      if (wanted.size === 0 && licensed) break;
    }
  }
  if (!licensed) throw new Error(`${file.path}: no COPYING found`);
  if (wanted.size > 0) throw new Error(`${file.path} lacks ${[...wanted.keys()].join(", ")}`);
  return {};
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Stream `recordings_all_time.jsonl` (one line per user) into `user_id \t mbid \t listens` rows. */
export async function extractListenBrainzStats(
  lock: SourcesLock,
  dumps: string,
  raw: string,
): Promise<Record<string, unknown>> {
  const file = one(lock, "lb-stats");
  const target = rawPaths(raw).lbRecordings;
  await mkdir(path.dirname(target), { recursive: true });
  let licensed = false;
  let users = 0;
  let rows = 0;
  let unmapped = 0;
  for await (const entry of openTar(localPath(dumps, file))) {
    if (/(?:^|\/)COPYING$/.test(entry.name)) {
      assertLicense((await entry.buffer()).toString("utf8"), "CC0-1.0", file.path);
      licensed = true;
      continue;
    }
    if (!/(?:^|\/)statistics\/recordings_all_time\.jsonl$/.test(entry.name)) continue;
    const out = createWriteStream(target);
    const decoder = new StringDecoder("utf8");
    let carry = "";
    const handle = async (line: string) => {
      if (!line) return;
      const doc = JSON.parse(line) as {
        user_id?: number;
        data?: { recording_mbid?: unknown; listen_count?: unknown }[];
      };
      if (typeof doc.user_id !== "number" || !Array.isArray(doc.data)) return;
      users++;
      const lines: string[] = [];
      for (const item of doc.data) {
        const mbid = item.recording_mbid;
        const count = item.listen_count;
        if (typeof mbid !== "string" || !UUID.test(mbid) || typeof count !== "number") {
          unmapped++;
          continue;
        }
        lines.push(`${doc.user_id}\t${mbid}\t${count}`);
      }
      rows += lines.length;
      if (lines.length > 0 && !out.write(`${lines.join("\n")}\n`)) await once(out, "drain");
    };
    for await (const chunk of entry.stream()) {
      const text = carry + decoder.write(chunk);
      const parts = text.split("\n");
      carry = parts.pop() ?? "";
      for (const line of parts) await handle(line);
    }
    await handle(carry + decoder.end());
    out.end();
    await once(out, "finish");
    break;
  }
  if (!licensed) throw new Error(`${file.path}: no COPYING found before the recordings file`);
  if (users === 0)
    throw new Error(`${file.path}: statistics/recordings_all_time.jsonl not found or empty`);
  return { users, rows, unmapped };
}

export async function extractAcousticBrainz(
  lock: SourcesLock,
  dumps: string,
  raw: string,
  log: Log,
): Promise<Record<string, unknown>> {
  const paths = rawPaths(raw);
  await mkdir(path.dirname(paths.abRhythm), { recursive: true });
  const parts = filesOf(lock, "ab-highlevel");
  const results = await convertHighlevelParts(
    parts.map((f, i) => ({ archive: localPath(dumps, f), out: paths.abHighlevel(i) })),
    log,
  );
  const rhythm = one(lock, "ab-rhythm");
  let found = false;
  for await (const entry of openTar(localPath(dumps, rhythm))) {
    if (entry.name.endsWith("-rhythm.csv")) {
      await writeEntry(entry, paths.abRhythm);
      found = true;
      break;
    }
  }
  if (!found) throw new Error(`${rhythm.path}: no rhythm CSV inside`);
  return {
    highlevelDocs: results.reduce((s, r) => s + r.docs, 0),
    highlevelRows: results.reduce((s, r) => s + r.rows, 0),
    highlevelSkipped: results.reduce((s, r) => s + r.skipped, 0),
  };
}

const shas = (lock: SourcesLock, ...sources: SourceId[]) =>
  lock.files.filter((f) => sources.includes(f.source)).map((f) => f.sha256);

export const EXTRACT_STEPS = [
  "extract-mb",
  "extract-canonical",
  "extract-lbstats",
  "extract-ab",
] as const;
export type ExtractStep = (typeof EXTRACT_STEPS)[number];

/** Run extraction steps (each skipped when its inputs are unchanged). */
export async function extractAll(
  lock: SourcesLock,
  dumps: string,
  raw: string,
  log: Log,
  opts: { readonly force?: boolean; readonly only?: readonly ExtractStep[] } = {},
): Promise<StepRecord[]> {
  const stamps = rawPaths(raw).stamps;
  const schema = MB_TABLES.map((t) => [t.name, t.columns.length]);
  const steps: Record<ExtractStep, [unknown, () => Promise<Record<string, unknown>>]> = {
    "extract-mb": [
      { s: shas(lock, "mb-core", "mb-derived"), schema },
      () => extractMusicBrainz(lock, dumps, raw),
    ],
    "extract-canonical": [shas(lock, "canonical"), () => extractCanonical(lock, dumps, raw)],
    "extract-lbstats": [shas(lock, "lb-stats"), () => extractListenBrainzStats(lock, dumps, raw)],
    "extract-ab": [
      shas(lock, "ab-highlevel", "ab-rhythm"),
      () => extractAcousticBrainz(lock, dumps, raw, log),
    ],
  };
  const out: StepRecord[] = [];
  for (const step of opts.only ?? EXTRACT_STEPS) {
    const [inputs, fn] = steps[step];
    out.push(await runStep(stamps, step, inputs, fn, log, opts.force));
  }
  return out;
}
