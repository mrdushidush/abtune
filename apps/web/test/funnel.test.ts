// Funnel counters: the source-tag counts per UTC hour, a server-side count of playlists built, and
// how long playlists take per hour on /api/health.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { CatalogManifest } from "@abtune/catalog";
import { loadCatalog } from "@abtune/catalog/reader";
import {
  createSession,
  engineVersion,
  reduceSession,
  type SessionState,
  sessionSeed,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import { afterAll, describe, expect, it } from "vitest";
import {
  type Health,
  type PlaylistRequest,
  type PlaylistResponse,
  SERVER_EVENTS,
  STAT_EVENTS,
} from "../src/api-types.ts";
import { createApp } from "../src/server/app.ts";
import { catalogInfo, catalogSlot } from "../src/server/catalog.ts";
import { HOURLY_EVENTS, HOURS_KEPT, Stats } from "../src/server/stats.ts";
import { nearestRank, PlaylistTimings, TIMING_HOURS } from "../src/server/timing.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

describe("HOURLY_EVENTS", () => {
  it("holds every count that carries a source tag, and nothing else", () => {
    for (const name of [...STAT_EVENTS, ...SERVER_EVENTS])
      expect(HOURLY_EVENTS.has(name), name).toBe(/^via_|_via_|^shortlink_/.test(name));
    expect(HOURLY_EVENTS.size).toBe(12);
  });
});

describe("Stats per hour", () => {
  it("counts the tagged events per UTC hour too, and the rest per day only", async () => {
    let now = new Date("2026-10-11T23:10:00Z");
    const stats = await Stats.open(null, () => now);
    stats.count("via_x_open");
    stats.count("quiz_start_via_x");
    stats.count("quiz_start");
    stats.count("shortlink_ig");
    now = new Date("2026-10-11T23:59:59.999Z");
    stats.count("quiz_done_via_x");
    now = new Date("2026-10-12T00:00:00Z");
    stats.count("quiz_done_via_x");
    stats.count("quiz_done");
    stats.count("playlist_built");

    expect(stats.snapshot()).toEqual({
      since: "2026-10-11",
      totals: {
        via_x_open: 1,
        quiz_start_via_x: 1,
        quiz_start: 1,
        shortlink_ig: 1,
        quiz_done_via_x: 2,
        quiz_done: 1,
        playlist_built: 1,
      },
      days: [
        { day: "2026-10-12", counts: { quiz_done_via_x: 1, quiz_done: 1, playlist_built: 1 } },
        {
          day: "2026-10-11",
          counts: {
            via_x_open: 1,
            quiz_start_via_x: 1,
            quiz_start: 1,
            shortlink_ig: 1,
            quiz_done_via_x: 1,
          },
        },
      ],
      hours: [
        { hour: "2026-10-12T00", counts: { quiz_done_via_x: 1 } },
        {
          hour: "2026-10-11T23",
          counts: { via_x_open: 1, quiz_start_via_x: 1, shortlink_ig: 1, quiz_done_via_x: 1 },
        },
      ],
    });
  });

  it("keeps the newest HOURS_KEPT hours in its file and drops bad saved ones", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "abtune-hours-")), "stats.json");
    const hour = (i: number) => new Date(Date.UTC(2026, 0, 1, i, 30));
    let now = hour(0);
    const first = await Stats.open(file, () => now);
    expect(HOURS_KEPT).toBe(14 * 24);
    for (let i = 0; i < HOURS_KEPT + 2; i++) {
      now = hour(i);
      first.count("via_tt_open");
    }
    // Shown before any write, too.
    const shown = first.snapshot().hours;
    expect(shown).toHaveLength(HOURS_KEPT);
    expect(shown[0]?.hour).toBe(
      hour(HOURS_KEPT + 1)
        .toISOString()
        .slice(0, 13),
    );
    expect(shown.at(-1)?.hour).toBe(hour(2).toISOString().slice(0, 13));
    await first.flush();

    const saved = JSON.parse(await readFile(file, "utf8")) as {
      days: Record<string, unknown>;
      hours: Record<string, Record<string, unknown>>;
    };
    const kept = Object.keys(saved.hours).sort();
    expect(kept).toHaveLength(HOURS_KEPT);
    expect(kept[0]).toBe(hour(2).toISOString().slice(0, 13));
    // Days are kept as before: all 15 of them.
    expect(Object.keys(saved.days)).toHaveLength(15);

    // A saved hour may hold only positive whole counts of the tagged names.
    saved.hours["2026-01-01T02"] = {
      via_tt_open: 2,
      quiz_done: 4,
      playlist_built: 3,
      hacked: 1,
      shortlink_x: -1,
      quiz_start_via_ig: 1.5,
    };
    await writeFile(file, JSON.stringify(saved));
    const second = await Stats.open(file, () => now);
    expect(second.snapshot().hours.at(-1)).toEqual({
      hour: "2026-01-01T02",
      counts: { via_tt_open: 2 },
    });
  });

  it("reads a file written before hours were kept", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "abtune-hours-")), "stats.json");
    await writeFile(
      file,
      JSON.stringify({ since: "2026-10-07", days: { "2026-10-07": { quiz_done: 17 } } }),
    );
    const now = new Date("2026-10-10T18:00:00Z");
    const stats = await Stats.open(file, () => now);
    expect(stats.snapshot().hours).toEqual([]);
    stats.count("via_ig_open");
    stats.count("playlist_built");
    await stats.flush();
    const saved = JSON.parse(await readFile(file, "utf8")) as unknown;
    expect(saved).toEqual({
      since: "2026-10-07",
      days: {
        "2026-10-07": { quiz_done: 17 },
        "2026-10-10": { via_ig_open: 1, playlist_built: 1 },
      },
      hours: { "2026-10-10T18": { via_ig_open: 1 } },
    });
    // And reads both back after a restart.
    const again = (await Stats.open(file, () => now)).snapshot();
    expect(again.totals).toEqual({ quiz_done: 17, via_ig_open: 1, playlist_built: 1 });
    expect(again.hours).toEqual([{ hour: "2026-10-10T18", counts: { via_ig_open: 1 } }]);
  });
});

describe("PlaylistTimings", () => {
  const range = (n: number) => Array.from({ length: n }, (_, i) => i + 1);

  it("takes percentiles by nearest rank", () => {
    for (const [n, p50, p95] of [
      [1, 1, 1],
      [2, 1, 2],
      [10, 5, 10],
      [20, 10, 19],
      [21, 11, 20],
      [100, 50, 95],
    ] as const) {
      expect(nearestRank(range(n), 50), `p50 of ${n}`).toBe(p50);
      expect(nearestRank(range(n), 95), `p95 of ${n}`).toBe(p95);
    }
  });

  it("summarizes each UTC hour and shows the 24 before the one under way", () => {
    let now = new Date("2026-10-10T10:05:00Z");
    const timings = new PlaylistTimings(() => now);
    expect(timings.hours()).toEqual([]);
    // Whole milliseconds, rounded: 299.6 is 300 and 200.4 is 200.
    timings.record(299.6);
    timings.record(99);
    timings.record(200.4);
    const ten = { hour: "2026-10-10T10", n: 3, p50_ms: 200, p95_ms: 300 };
    expect(timings.hours()).toEqual([ten]);

    now = new Date("2026-10-10T11:00:00Z");
    expect(timings.hours()).toEqual([ten]);
    for (const ms of range(20).reverse()) timings.record(ms);
    const eleven = { hour: "2026-10-10T11", n: 20, p50_ms: 10, p95_ms: 19 };
    expect(timings.hours()).toEqual([eleven, ten]);

    // 10:00 is still one of the 24 hours before 10:00 the next day, and gone an hour later.
    expect(TIMING_HOURS).toBe(24);
    now = new Date("2026-10-11T10:59:59Z");
    expect(timings.hours()).toEqual([eleven, ten]);
    now = new Date("2026-10-11T11:00:00Z");
    expect(timings.hours()).toEqual([eleven]);
    now = new Date("2026-10-11T12:00:00Z");
    expect(timings.hours()).toEqual([]);
  });
});

describe("POST /api/playlist counts and times what it builds", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: repo("data/questions") });
  if (!bank) throw new Error("seed bank failed to load");
  const dir = repo("data/catalog-fixture");
  const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8")) as CatalogManifest;
  const loaded = await loadCatalog(dir, bank.dimensions, { threads: 2 });
  afterAll(() => loaded.close());
  const info = catalogInfo(manifest);
  const catalog = catalogSlot(info, Promise.resolve(loaded));
  await catalog.settled;

  let state: SessionState = createSession(bank, { mode: 10, length: 25 });
  while (viewSession(bank, state).status === "asking")
    state = reduceSession(bank, state, { type: "answer", choice: "a" });
  const request: PlaylistRequest = {
    taste: tasteVector(bank, viewSession(bank, state).profile),
    seed: sessionSeed(bank, state, info.version),
    length: 25,
    engine_version: engineVersion(bank),
    catalog_version: info.version,
  };

  const now = new Date("2026-10-12T09:30:00Z");
  /** Each reading is 250 ms after the last, so every timed request took 250 ms. */
  const steppingClock = () => {
    let t = 0;
    return () => (t += 250);
  };
  const post = (app: ReturnType<typeof createApp>, body: unknown) =>
    app.request("/api/playlist", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.7" },
      body: JSON.stringify(body),
    });
  const timing = async (app: ReturnType<typeof createApp>) =>
    ((await (await app.request("/api/health")).json()) as Health).playlist_timing;

  it("counts and times each playlist built, and no refused request", async () => {
    const stats = await Stats.open(null, () => now);
    const timings = new PlaylistTimings(() => now, steppingClock());
    const app = createApp({ bank, version: "9.9.9", catalog, stats, timings });

    const first = await post(app, request);
    expect(first.status).toBe(200);
    const shown = ((await first.json()) as PlaylistResponse).tracks.map((t) => t.track_id);
    // "+25 deeper cuts" builds one more.
    expect((await post(app, { ...request, previous: shown })).status).toBe(200);
    // Refused before the build, and inside it.
    expect((await post(app, { ...request, seed: "XYZ" })).status).toBe(400);
    expect((await post(app, { ...request, engine_version: "0.0.0+bank.x" })).status).toBe(409);
    expect(
      (await post(app, { ...request, previous: ["00000000-0000-0000-0000-000000000000"] })).status,
    ).toBe(400);

    expect(stats.snapshot().totals).toEqual({ playlist_built: 2 });
    // Not a tagged count, so not per hour.
    expect(stats.snapshot().hours).toEqual([]);
    expect(await timing(app)).toEqual([{ hour: "2026-10-12T09", n: 2, p50_ms: 250, p95_ms: 250 }]);

    // Only the server counts it.
    const event = await app.request("/api/event", {
      method: "POST",
      body: '{"e":"playlist_built"}',
      headers: { origin: "http://localhost" },
    });
    expect(event.status).toBe(400);
    expect(stats.snapshot().totals).toEqual({ playlist_built: 2 });
  });

  it("doesn't count or time a request past the visitor's limit", async () => {
    const stats = await Stats.open(null, () => now);
    const timings = new PlaylistTimings(() => now, steppingClock());
    const app = createApp({
      bank,
      version: "9.9.9",
      catalog,
      stats,
      timings,
      playlistLimit: { perMinute: 2, trustProxy: true },
    });
    expect((await post(app, request)).status).toBe(200);
    expect((await post(app, request)).status).toBe(200);
    expect((await post(app, request)).status).toBe(429);
    expect(stats.snapshot().totals).toEqual({ playlist_built: 2 });
    expect((await timing(app))[0]?.n).toBe(2);
  });

  it("times playlists without STATS_FILE too", async () => {
    const app = createApp({ bank, version: "9.9.9", catalog });
    expect(await timing(app)).toEqual([]);
    expect((await post(app, request)).status).toBe(200);
    const [hour] = await timing(app);
    expect(hour?.n).toBe(1);
    expect(hour?.p95_ms).toBeGreaterThanOrEqual(0);
  });
});
