// A public instance: share links and link previews point at its public URL, and it may count usage
// events (names only).
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { describe, expect, it } from "vitest";
import { createApp, PUBLIC_INSTANCE_URL, shareBaseUrl } from "../src/server/app.ts";
import { DAYS_SHOWN, Stats } from "../src/server/stats.ts";

const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));

describe("shareBaseUrl", () => {
  it("prefers SHARE_BASE_URL, then a public APP_BASE_URL, else the public instance", () => {
    expect(shareBaseUrl("https://music.example.org", "https://share.example.net/abtune")).toBe(
      "https://share.example.net/abtune/",
    );
    expect(shareBaseUrl("https://music.example.org")).toBe("https://music.example.org/");
    expect(shareBaseUrl("https://music.example.org/sub///")).toBe("https://music.example.org/sub/");
    for (const local of [
      "http://127.0.0.1:8787",
      "http://localhost:8787",
      "http://abtune.localhost",
      "http://192.168.1.5:8787",
      "http://[::1]:8787",
      "http://nas:8787",
      "not a url",
      undefined,
    ])
      expect(shareBaseUrl(local), String(local)).toBe(PUBLIC_INSTANCE_URL);
    // An explicit share URL may be local (a home network that shares among itself).
    expect(shareBaseUrl("http://127.0.0.1:8787", "http://192.168.1.5:8787")).toBe(
      "http://192.168.1.5:8787/",
    );
    expect(shareBaseUrl(undefined, "ftp://example.com")).toBe(PUBLIC_INSTANCE_URL);
  });
});

describe("public instance", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
  if (!bank) throw new Error("seed bank failed to load");

  it("fills its public URL into the page's link-preview tags", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "abtune-static-"));
    await writeFile(
      path.join(dir, "index.html"),
      '<meta property="og:url" content="__ABTUNE_URL__" /><meta property="og:image" content="__ABTUNE_URL__og.png" />',
    );
    const app = createApp({
      bank,
      version: "9.9.9",
      staticRoot: dir,
      publicUrl: 'https://abtune.example.com/"x/',
      hosts: ["abtune.example.com"],
    });
    for (const route of ["/", "/index.html", "/some/client/route"]) {
      const res = await app.request(`https://abtune.example.com${route}`);
      expect(res.status, route).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/html");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const html = await res.text();
      expect(html).not.toContain("__ABTUNE_URL__");
      expect(html).toContain('content="https://abtune.example.com/&quot;x/og.png"');
    }
    const health = (await (await app.request("/api/health")).json()) as { share_url: string };
    expect(health.share_url).toBe('https://abtune.example.com/"x/');
  });

  it("has no event or stats routes unless it counts", async () => {
    const app = createApp({ bank, version: "9.9.9" });
    expect(
      (await app.request("/api/event", { method: "POST", body: '{"e":"quiz_done"}' })).status,
    ).toBe(404);
    expect((await app.request("/api/stats")).status).toBe(404);
  });

  it("counts known events by UTC day and nothing else", async () => {
    let now = new Date("2026-10-11T23:59:00Z");
    const stats = await Stats.open(null, () => now);
    const app = createApp({ bank, version: "9.9.9", stats });
    const post = (body: string, headers: Record<string, string> = {}) =>
      app.request("/api/event", { method: "POST", body, headers });

    expect((await post('{"e":"quiz_done"}')).status).toBe(204);
    expect((await post('{"e":"quiz_done"}', { origin: "http://localhost" })).status).toBe(204);
    now = new Date("2026-10-12T00:00:01Z");
    expect((await post('{"e":"share_link"}')).status).toBe(204);
    expect((await post('{"e":"profile","taste":[1,2,3]}')).status).toBe(400);
    expect((await post("not json")).status).toBe(400);
    expect((await post('{"e":"quiz_done"}', { origin: "https://evil.example" })).status).toBe(403);
    expect((await post(`{"e":"quiz_done","pad":"${"x".repeat(400)}"}`)).status).toBe(413);

    const res = await app.request("/api/stats");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      since: "2026-10-11",
      totals: { quiz_done: 2, share_link: 1 },
      days: [
        { day: "2026-10-12", counts: { share_link: 1 } },
        { day: "2026-10-11", counts: { quiz_done: 2 } },
      ],
    });
    const health = (await (await app.request("/api/health")).json()) as { stats: boolean };
    expect(health.stats).toBe(true);
  });

  it("keeps the counts in its file across restarts", async () => {
    const file = path.join(
      await mkdtemp(path.join(tmpdir(), "abtune-stats-")),
      "sub",
      "stats.json",
    );
    let now = new Date("2026-01-01T10:00:00Z");
    const first = await Stats.open(file, () => now);
    for (let d = 0; d < DAYS_SHOWN + 5; d++) {
      now = new Date(Date.UTC(2026, 0, 1 + d, 10));
      first.count("quiz_start");
    }
    first.count("export_csv");
    await first.flush();
    const saved = JSON.parse(await readFile(file, "utf8")) as { since: string };
    expect(saved.since).toBe("2026-01-01");

    // A bad entry in the file is dropped, not trusted.
    const raw = JSON.parse(await readFile(file, "utf8")) as {
      days: Record<string, Record<string, unknown>>;
    };
    raw.days["2026-01-01"] = { quiz_start: 1, hacked: 5, quiz_done: -3 };
    await writeFile(file, JSON.stringify(raw));

    const second = await Stats.open(file, () => now);
    second.count("quiz_start");
    const snap = second.snapshot();
    expect(snap.since).toBe("2026-01-01");
    expect(snap.totals).toEqual({ quiz_start: DAYS_SHOWN + 6, export_csv: 1 });
    expect(snap.days).toHaveLength(DAYS_SHOWN);
    expect(snap.days[0]).toEqual({ day: "2026-04-05", counts: { quiz_start: 2, export_csv: 1 } });
  });
});
