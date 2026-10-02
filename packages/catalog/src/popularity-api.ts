// ListenBrainz popularity API top-up (stage 4): exact listener counts (ListenBrainz + MLHD+) for
// the candidate recordings, cached append-only so runs resume and rebuilds reuse the snapshot.
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { USER_AGENT } from "./sources.ts";

export const POPULARITY_ENDPOINT = "https://api.listenbrainz.org/1/popularity/recording";
/** Verified 2026-10-01: 1,001 MBIDs → HTTP 400 "Maximum … is 1000". */
export const MAX_BATCH = 1000;

export interface PopularityRow {
  readonly gid: string;
  readonly users: number | null;
  readonly listens: number | null;
}

export interface ApiOptions {
  /** Snapshot directory; holds popularity.tsv (gid, users, listens) and meta.json. */
  readonly cacheDir: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly endpoint?: string;
  readonly batchSize?: number;
  readonly retries?: number;
}

export const CACHE_FILE = "popularity.tsv";

export async function readPopularityCache(cacheDir: string): Promise<Map<string, PopularityRow>> {
  const out = new Map<string, PopularityRow>();
  let text = "";
  try {
    text = await readFile(path.join(cacheDir, CACHE_FILE), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  for (const line of text.split("\n")) {
    const [gid, users, listens] = line.split("\t");
    if (!gid || users === undefined || listens === undefined) continue; // a torn last line is refetched
    out.set(gid, {
      gid,
      users: users === "" ? null : Number(users),
      listens: listens === "" ? null : Number(listens),
    });
  }
  return out;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function headerSeconds(res: Response, name: string): number | undefined {
  const v = res.headers.get(name);
  if (v === null) return undefined;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/**
 * Fetch popularity for every MBID not already cached. Serial requests, at most 1,000 MBIDs each,
 * pausing whenever the rate-limit window is used up. Returns counts for the report.
 */
export async function fetchPopularity(
  mbids: readonly string[],
  opts: ApiOptions,
): Promise<{
  readonly requested: number;
  readonly cached: number;
  readonly fetched: number;
  readonly calls: number;
}> {
  const {
    cacheDir,
    fetchImpl = fetch,
    log = () => {},
    sleep = realSleep,
    endpoint = POPULARITY_ENDPOINT,
    batchSize = MAX_BATCH,
    retries = 8,
  } = opts;
  await mkdir(cacheDir, { recursive: true });
  const metaFile = path.join(cacheDir, "meta.json");
  try {
    await readFile(metaFile);
  } catch {
    await writeFile(
      metaFile,
      `${JSON.stringify({ endpoint, started: new Date().toISOString() }, null, 2)}\n`,
    );
  }
  const cache = await readPopularityCache(cacheDir);
  const todo = [...new Set(mbids)].filter((m) => !cache.has(m)).sort();
  const total = Math.ceil(todo.length / batchSize);
  let calls = 0;
  if (todo.length > 0)
    log(
      `Popularity API: ${todo.length.toLocaleString("en")} MBIDs to fetch in ${total} calls (${cache.size.toLocaleString("en")} cached)`,
    );
  const started = Date.now();
  for (let b = 0; b < total; b++) {
    const batch = todo.slice(b * batchSize, (b + 1) * batchSize);
    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetchImpl(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", "user-agent": USER_AGENT },
          body: JSON.stringify({ recording_mbids: batch }),
        });
      } catch (e) {
        if (attempt >= retries) throw new Error(`popularity API: ${(e as Error).message}`);
        await sleep(Math.min(60_000, 1000 * 2 ** attempt));
        continue;
      }
      calls++;
      if (res.status === 429 || res.status >= 500) {
        await res.body?.cancel();
        if (attempt >= retries)
          throw new Error(`popularity API: HTTP ${res.status} after ${retries} retries`);
        const wait =
          headerSeconds(res, "retry-after") ??
          headerSeconds(res, "x-ratelimit-reset-in") ??
          2 ** attempt;
        log(`  HTTP ${res.status}; waiting ${wait}s`);
        await sleep(Math.min(120, Math.max(1, wait)) * 1000);
        continue;
      }
      if (!res.ok)
        throw new Error(`popularity API: HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
      const rows = (await res.json()) as {
        recording_mbid: string;
        total_user_count: number | null;
        total_listen_count: number | null;
      }[];
      const lines = rows.map(
        (r) => `${r.recording_mbid}\t${r.total_user_count ?? ""}\t${r.total_listen_count ?? ""}`,
      );
      await appendFile(path.join(cacheDir, CACHE_FILE), `${lines.join("\n")}\n`);
      if (headerSeconds(res, "x-ratelimit-remaining") === 0) {
        await sleep(((headerSeconds(res, "x-ratelimit-reset-in") ?? 10) + 0.5) * 1000);
      }
      break;
    }
    if ((b + 1) % 200 === 0 || b + 1 === total) {
      const rate = (b + 1) / ((Date.now() - started) / 1000);
      log(
        `  popularity API: ${b + 1}/${total} calls, ${rate.toFixed(2)}/s, ~${Math.round((total - b - 1) / rate / 60)} min left`,
      );
    }
  }
  return { requested: mbids.length, cached: cache.size, fetched: todo.length, calls };
}
