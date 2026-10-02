// Resumable, checksummed downloads of the source dumps (HANDOFF §6.2 stage 1).
import { createHash, type Hash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { type LockedFile, type SourcesLock, USER_AGENT } from "./sources.ts";

export const LOCK_FILE = "sources.lock.json";

export interface DownloadOptions {
  /** Dumps directory; locked paths resolve against it. */
  readonly dir: string;
  readonly concurrency?: number;
  readonly retries?: number;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
  /** Base delay between retries (doubles each attempt, capped at 60 s). */
  readonly retryDelayMs?: number;
  readonly progressEveryMs?: number;
}

export async function readLock(dir: string): Promise<SourcesLock | undefined> {
  try {
    return JSON.parse(await readFile(path.join(dir, LOCK_FILE), "utf8")) as SourcesLock;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

export async function writeLock(dir: string, lock: SourcesLock): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, LOCK_FILE), `${JSON.stringify(lock, null, 2)}\n`);
}

/** Absolute path of a locked file. */
export function localPath(dir: string, file: LockedFile): string {
  return path.join(dir, ...file.path.split("/"));
}

async function sizeOf(p: string): Promise<number | undefined> {
  try {
    return (await stat(p)).size;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
}

async function hashInto(hash: Hash, p: string): Promise<void> {
  for await (const chunk of createReadStream(p, { highWaterMark: 4 << 20 })) hash.update(chunk);
}

/** True when `file` is on disk and matches its locked sha256 (memoized in a `.verified` sidecar). */
export async function isVerified(dir: string, file: LockedFile): Promise<boolean> {
  const p = localPath(dir, file);
  if ((await sizeOf(p)) === undefined) return false;
  try {
    if ((await readFile(`${p}.verified`, "utf8")).trim() === file.sha256) return true;
  } catch {}
  const hash = createHash("sha256");
  await hashInto(hash, p);
  if (hash.digest("hex") !== file.sha256) return false;
  await writeFile(`${p}.verified`, `${file.sha256}\n`);
  return true;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Bytes received across all transfers, for progress lines. */
interface Progress {
  bytes: number;
}

/**
 * Download one file to `<path>.part`, resuming with an HTTP Range request after any
 * interruption, then verify sha256 and rename into place.
 */
export async function downloadFile(
  file: LockedFile,
  opts: DownloadOptions,
  progress: Progress = { bytes: 0 },
): Promise<"present" | "downloaded"> {
  const { dir, retries = 8, retryDelayMs = 2000, fetchImpl = fetch, log = () => {} } = opts;
  const final = localPath(dir, file);
  if (await isVerified(dir, file)) return "present";
  if ((await sizeOf(final)) !== undefined) {
    log(`${file.path}: checksum mismatch, downloading again`);
    await rm(final);
  }
  await mkdir(path.dirname(final), { recursive: true });
  const part = `${final}.part`;

  for (let attempt = 0; ; attempt++) {
    try {
      const offset = (await sizeOf(part)) ?? 0;
      const hash = createHash("sha256");
      if (offset > 0) await hashInto(hash, part);
      const res = await fetchImpl(file.url, {
        headers: { "user-agent": USER_AGENT, ...(offset > 0 ? { range: `bytes=${offset}-` } : {}) },
      });
      if (res.status === 416 && offset > 0) {
        // Nothing left to fetch: the part file is already complete (or corrupt).
        await res.body?.cancel();
      } else {
        if (res.status !== 200 && res.status !== 206) {
          await res.body?.cancel();
          throw new Error(`HTTP ${res.status}`);
        }
        if (res.status === 200 && offset > 0) {
          // The server ignored the Range header: drop the partial file and retry from zero.
          await res.body?.cancel();
          await rm(part, { force: true });
          throw new Error("server ignored the Range request; restarting");
        }
        if (!res.body) throw new Error("empty response body");
        // Awaited writes (not a stream pipeline) so every received byte is on disk if the
        // connection drops, and the next attempt resumes from there.
        const fh = await open(part, offset > 0 ? "a" : "w");
        try {
          for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
            hash.update(chunk);
            await fh.write(chunk);
            progress.bytes += chunk.length;
          }
        } finally {
          await fh.close();
        }
      }
      const digest = hash.digest("hex");
      if (digest !== file.sha256) {
        await rm(part, { force: true });
        throw new Error(
          `sha256 mismatch (got ${digest.slice(0, 12)}…, want ${file.sha256.slice(0, 12)}…)`,
        );
      }
      await rename(part, final);
      await writeFile(`${final}.verified`, `${file.sha256}\n`);
      return "downloaded";
    } catch (e) {
      if (attempt >= retries) throw new Error(`${file.path}: ${(e as Error).message}`);
      const wait = Math.min(60_000, retryDelayMs * 2 ** attempt);
      log(
        `${file.path}: ${(e as Error).message}; retry ${attempt + 1}/${retries} in ${wait / 1000}s`,
      );
      await sleep(wait);
    }
  }
}

function gb(bytes: number): string {
  return `${(bytes / 1e9).toFixed(2)} GB`;
}

/** Download every locked file with a small worker pool, logging progress periodically. */
export async function downloadAll(lock: SourcesLock, opts: DownloadOptions): Promise<void> {
  const { concurrency = 3, log = () => {}, progressEveryMs = 30_000 } = opts;
  const queue = [...lock.files];
  const progress: Progress = { bytes: 0 };
  const started = Date.now();
  let active = 0;
  const timer = setInterval(() => {
    const secs = (Date.now() - started) / 1000;
    log(
      `… ${gb(progress.bytes)} received, ${(progress.bytes / 1e6 / secs).toFixed(1)} MB/s, ${active} active, ${queue.length} queued`,
    );
  }, progressEveryMs);
  timer.unref();
  const failures: string[] = [];
  const worker = async () => {
    for (let file = queue.shift(); file; file = queue.shift()) {
      active++;
      try {
        const result = await downloadFile(file, opts, progress);
        log(`${result === "present" ? "✓ present " : "✓ fetched "} ${file.path}`);
      } catch (e) {
        failures.push((e as Error).message);
        log(`✗ ${(e as Error).message}`);
      } finally {
        active--;
      }
    }
  };
  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    clearInterval(timer);
  }
  if (failures.length > 0)
    throw new Error(`${failures.length} download(s) failed:\n${failures.join("\n")}`);
  log(
    `All ${lock.files.length} files present and verified (${gb(progress.bytes)} fetched this run).`,
  );
}
