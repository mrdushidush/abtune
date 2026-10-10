// How long this server takes to build playlists, per UTC hour (GET /api/health `playlist_timing`),
// so a host that has grown too slow shows up in numbers before visitors feel it. Durations only,
// in memory: about 8 bytes a playlist for the hour under way (one vCPU builds at most about 8,000
// an hour), and a summary for each earlier hour.
import type { PlaylistTiming } from "../api-types.ts";
import { hourOf } from "./stats.ts";

/** Earlier hours shown besides the one under way. */
export const TIMING_HOURS = 24;

const HOUR_MS = 3_600_000;

/**
 * The `p`th percentile (0 < p ≤ 100) of a non-empty sorted list, by nearest rank: the smallest value
 * with at least p% of the list at or below it.
 */
export const nearestRank = (sorted: readonly number[], p: number): number =>
  sorted[Math.ceil((p / 100) * sorted.length) - 1] as number;

function summarize(hour: string, ms: readonly number[]): PlaylistTiming {
  const sorted = [...ms].sort((a, b) => a - b);
  return {
    hour,
    n: sorted.length,
    p50_ms: nearestRank(sorted, 50),
    p95_ms: nearestRank(sorted, 95),
  };
}

export class PlaylistTimings {
  private readonly now: () => Date;
  /** Milliseconds, for timing a request. */
  readonly clock: () => number;
  private hour = "";
  private samples: number[] = [];
  /** Earlier hours, newest first. */
  private past: PlaylistTiming[] = [];

  constructor(now: () => Date = () => new Date(), clock: () => number = () => performance.now()) {
    this.now = now;
    this.clock = clock;
  }

  record(ms: number): void {
    this.roll();
    this.samples.push(Math.round(ms));
  }

  /** The hour under way (if it built any), then the earlier hours that did, newest first. */
  hours(): PlaylistTiming[] {
    this.roll();
    return this.samples.length > 0
      ? [summarize(this.hour, this.samples), ...this.past]
      : [...this.past];
  }

  /** On a new hour: summarize the last one, and drop hours older than `TIMING_HOURS`. */
  private roll(): void {
    const now = this.now();
    const hour = hourOf(now);
    if (hour === this.hour) return;
    if (this.samples.length > 0) this.past.unshift(summarize(this.hour, this.samples));
    this.hour = hour;
    this.samples = [];
    const oldest = hourOf(new Date(now.getTime() - TIMING_HOURS * HOUR_MS));
    this.past = this.past.filter((t) => t.hour >= oldest);
  }
}
