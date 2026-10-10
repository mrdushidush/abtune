// Usage counters for a public instance (STATS_FILE, off by default): how many quizzes were
// started and finished, playlists built, links shared and playlists exported, visits through the
// short links, per UTC day, and the source-tag counts per UTC hour too. Event names and numbers
// only: no IDs, IP addresses, cookies or profiles, so nothing here tells two visitors apart.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type CountedEvent,
  SERVER_EVENTS,
  STAT_EVENTS,
  type StatEvent,
  VIA_TAGS,
} from "../api-types.ts";

/** A name a browser may send to /api/event. */
export const isStatEvent = (x: unknown): x is StatEvent =>
  typeof x === "string" && (STAT_EVENTS as readonly string[]).includes(x);

/** A name the counts may hold: a browser's, or one the server counts itself. */
export const isCountedEvent = (x: unknown): x is CountedEvent =>
  isStatEvent(x) || (typeof x === "string" && (SERVER_EVENTS as readonly string[]).includes(x));

/** The counts per source tag, kept per UTC hour too, so a post can be lined up with its traffic. */
export const HOURLY_EVENTS: ReadonlySet<CountedEvent> = new Set<CountedEvent>(
  VIA_TAGS.flatMap(
    (t) =>
      [`via_${t}_open`, `quiz_start_via_${t}`, `quiz_done_via_${t}`, `shortlink_${t}`] as const,
  ),
);

type Counts = Partial<Record<CountedEvent, number>>;

export interface StatsSnapshot {
  /** The first day counted (UTC, YYYY-MM-DD). */
  readonly since: string;
  readonly totals: Counts;
  /** Per UTC day, newest first, at most `DAYS_SHOWN`. */
  readonly days: readonly { readonly day: string; readonly counts: Counts }[];
  /** `HOURLY_EVENTS` per UTC hour (YYYY-MM-DDTHH), newest first, at most `HOURS_KEPT`. */
  readonly hours: readonly { readonly hour: string; readonly counts: Counts }[];
}

/** Days kept in the file and shown by GET /api/stats. */
export const DAYS_KEPT = 400;
export const DAYS_SHOWN = 90;
/** Hours kept and shown: two weeks when every hour has a count. */
export const HOURS_KEPT = 14 * 24;

const dayOf = (now: Date) => now.toISOString().slice(0, 10);
export const hourOf = (now: Date) => now.toISOString().slice(0, 13);

/** Saved counts, minus anything that isn't a positive whole count of a name `keep` allows. */
function cleanCounts(saved: Record<string, Counts>, keep: (k: string) => boolean) {
  const out = new Map<string, Counts>();
  for (const [key, counts] of Object.entries(saved)) {
    const clean: Counts = {};
    for (const [k, v] of Object.entries(counts))
      if (isCountedEvent(k) && keep(k) && Number.isSafeInteger(v) && v > 0) clean[k] = v;
    out.set(key, clean);
  }
  return out;
}

const newest = (map: Map<string, Counts>, n: number) =>
  [...map.keys()].sort().reverse().slice(0, n);

export class Stats {
  private readonly file: string | null;
  private readonly now: () => Date;
  private since: string;
  private days = new Map<string, Counts>();
  private hours = new Map<string, Counts>();
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
    const saved = JSON.parse(text) as {
      since?: string;
      days?: Record<string, Counts>;
      hours?: Record<string, Counts>;
    };
    if (typeof saved.since === "string") stats.since = saved.since;
    stats.days = cleanCounts(saved.days ?? {}, () => true);
    stats.hours = cleanCounts(saved.hours ?? {}, (k) => HOURLY_EVENTS.has(k as CountedEvent));
    return stats;
  }

  count(event: CountedEvent): void {
    const now = this.now();
    bump(this.days, dayOf(now), event);
    if (HOURLY_EVENTS.has(event)) bump(this.hours, hourOf(now), event);
    this.dirty = true;
  }

  snapshot(): StatsSnapshot {
    const totals: Counts = {};
    for (const counts of this.days.values())
      for (const [k, v] of Object.entries(counts) as [CountedEvent, number][])
        totals[k] = (totals[k] ?? 0) + v;
    const days = newest(this.days, DAYS_SHOWN).map((day) => ({
      day,
      counts: { ...this.days.get(day) },
    }));
    const hours = newest(this.hours, HOURS_KEPT).map((hour) => ({
      hour,
      counts: { ...this.hours.get(hour) },
    }));
    return { since: this.since, totals, days, hours };
  }

  /** Write the file if anything changed (atomically: a temp file, then rename). */
  async flush(): Promise<void> {
    if (!this.file || !this.dirty) return;
    this.dirty = false;
    prune(this.days, DAYS_KEPT);
    prune(this.hours, HOURS_KEPT);
    const body = {
      since: this.since,
      days: Object.fromEntries(this.days),
      hours: Object.fromEntries(this.hours),
    };
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

function bump(map: Map<string, Counts>, key: string, event: CountedEvent) {
  const counts = map.get(key) ?? {};
  counts[event] = (counts[event] ?? 0) + 1;
  map.set(key, counts);
}

/** Keep the newest `n` keys. */
function prune(map: Map<string, Counts>, n: number) {
  const keep = new Set(newest(map, n));
  for (const key of map.keys()) if (!keep.has(key)) map.delete(key);
}
