// Usage counters for a public instance (STATS_FILE, off by default): how many quizzes were
// started and finished, links shared and playlists exported, visits through the short links, per
// UTC day. Event names and numbers only: no IDs, IP addresses, cookies or profiles, so nothing here
// tells two visitors apart.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type CountedEvent, SERVER_EVENTS, STAT_EVENTS, type StatEvent } from "../api-types.ts";

/** A name a browser may send to /api/event. */
export const isStatEvent = (x: unknown): x is StatEvent =>
  typeof x === "string" && (STAT_EVENTS as readonly string[]).includes(x);

/** A name the counts may hold: a browser's, or one the server counts itself. */
export const isCountedEvent = (x: unknown): x is CountedEvent =>
  isStatEvent(x) || (typeof x === "string" && (SERVER_EVENTS as readonly string[]).includes(x));

type Counts = Partial<Record<CountedEvent, number>>;

export interface StatsSnapshot {
  /** The first day counted (UTC, YYYY-MM-DD). */
  readonly since: string;
  readonly totals: Counts;
  /** Per UTC day, newest first, at most `DAYS_SHOWN`. */
  readonly days: readonly { readonly day: string; readonly counts: Counts }[];
}

/** Days kept in the file and shown by GET /api/stats. */
export const DAYS_KEPT = 400;
export const DAYS_SHOWN = 90;

const dayOf = (now: Date) => now.toISOString().slice(0, 10);

export class Stats {
  private readonly file: string | null;
  private readonly now: () => Date;
  private since: string;
  private readonly days = new Map<string, Counts>();
  private dirty = false;

  private constructor(file: string | null, now: () => Date) {
    this.file = file;
    this.now = now;
    this.since = dayOf(now());
  }

  /** Counters kept in `file` (read now if it exists), or in memory only when `file` is null. */
  static async open(file: string | null, now: () => Date = () => new Date()): Promise<Stats> {
    const stats = new Stats(file, now);
    if (!file) return stats;
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return stats;
      throw err;
    }
    const saved = JSON.parse(text) as { since?: string; days?: Record<string, Counts> };
    if (typeof saved.since === "string") stats.since = saved.since;
    for (const [day, counts] of Object.entries(saved.days ?? {})) {
      const clean: Counts = {};
      for (const [k, v] of Object.entries(counts))
        if (isCountedEvent(k) && Number.isSafeInteger(v) && v > 0) clean[k] = v;
      stats.days.set(day, clean);
    }
    return stats;
  }

  count(event: CountedEvent): void {
    const day = dayOf(this.now());
    const counts = this.days.get(day) ?? {};
    counts[event] = (counts[event] ?? 0) + 1;
    this.days.set(day, counts);
    this.dirty = true;
  }

  snapshot(): StatsSnapshot {
    const totals: Counts = {};
    for (const counts of this.days.values())
      for (const [k, v] of Object.entries(counts) as [CountedEvent, number][])
        totals[k] = (totals[k] ?? 0) + v;
    const days = [...this.days.keys()]
      .sort()
      .reverse()
      .slice(0, DAYS_SHOWN)
      .map((day) => ({ day, counts: { ...this.days.get(day) } }));
    return { since: this.since, totals, days };
  }

  /** Write the file if anything changed (atomically: a temp file, then rename). */
  async flush(): Promise<void> {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    const keep = new Set([...this.days.keys()].sort().slice(-DAYS_KEPT));
    for (const day of this.days.keys()) if (!keep.has(day)) this.days.delete(day);
    const body = { since: this.since, days: Object.fromEntries(this.days) };
    try {
      await mkdir(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, `${JSON.stringify(body, null, 1)}\n`);
      await rename(tmp, this.file);
    } catch (err) {
      this.dirty = true;
      throw err;
    }
  }
}
