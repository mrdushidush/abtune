// Typed short links (/x, /ig, /tt): where they land, and which hits count.
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { describe, expect, it } from "vitest";
import { SERVER_EVENTS, STAT_EVENTS, VIA_TAGS } from "../src/api-types.ts";
import { createApp } from "../src/server/app.ts";
import { shortLinkTag } from "../src/server/shortlinks.ts";
import { isCountedEvent, isStatEvent, Stats } from "../src/server/stats.ts";

const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));

const SAFARI =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1";
const INSTAGRAM =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 389.0.0.29.87 (iPhone15,3; iOS 18_6; en_US; en; scale=3.00; 1290x2796; 745093318)";
const TIKTOK =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/141.0.0.0 Mobile Safari/537.36 trill_410203 JsSdk/1.0 NetType/WIFI Channel/googleplay AppName/musical_ly app_version/41.2.3 ByteLocale/en BytedanceWebview/d8a21c6";
const X_APP =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Twitter for iPhone/11.20";
const BROWSER = { "sec-fetch-mode": "navigate", "user-agent": SAFARI };

describe("shortLinkTag", () => {
  it("names a tag in any case, with or without one trailing slash", () => {
    expect(shortLinkTag("/x")).toBe("x");
    expect(shortLinkTag("/X")).toBe("x");
    expect(shortLinkTag("/ig/")).toBe("ig");
    expect(shortLinkTag("/Ig")).toBe("ig");
    expect(shortLinkTag("/TT")).toBe("tt");
    for (const p of ["/", "", "/xx", "/x/y", "//x", "/x//", "/igloo", "/facebook", "/api/x", "/ x"])
      expect(shortLinkTag(p), p).toBeNull();
  });

  it("has a counter for each tag, which a browser can't send", () => {
    expect(SERVER_EVENTS).toHaveLength(VIA_TAGS.length);
    for (const tag of VIA_TAGS) {
      expect(isCountedEvent(`shortlink_${tag}`)).toBe(true);
      expect(isStatEvent(`shortlink_${tag}`)).toBe(false);
    }
    for (const e of STAT_EVENTS) expect(isCountedEvent(e), e).toBe(true);
    expect(isCountedEvent("shortlink_fb")).toBe(false);
  });
});

describe("short links", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
  if (!bank) throw new Error("seed bank failed to load");
  const counting = () => Stats.open(null, () => new Date("2026-10-11T12:00:00Z"));
  const get = (
    app: ReturnType<typeof createApp>,
    route: string,
    headers: Record<string, string> = BROWSER,
    method = "GET",
  ) => app.request(route, { method, headers });

  it("land on the tagged page, uncached, and count a browser's visit", async () => {
    const stats = await counting();
    const app = createApp({ bank, version: "9.9.9", stats });
    for (const [route, tag] of [
      ["/x", "x"],
      ["/IG", "ig"],
      ["/tt/", "tt"],
      ["/ig?fbclid=abc", "ig"],
    ]) {
      const res = await get(app, route as string);
      expect(res.status, route).toBe(302);
      expect(res.headers.get("location"), route).toBe(`/?via=${tag}`);
      expect(res.headers.get("cache-control"), route).toBe("no-store");
    }
    expect(stats.snapshot().totals).toEqual({ shortlink_x: 1, shortlink_ig: 2, shortlink_tt: 1 });
  });

  it("count apps' own browsers, but not link previews, scripts or HEAD", async () => {
    const stats = await counting();
    const app = createApp({ bank, version: "9.9.9", stats });
    for (const agent of [SAFARI, INSTAGRAM, TIKTOK, X_APP])
      expect(
        (await get(app, "/x", { "sec-fetch-mode": "navigate", "user-agent": agent })).status,
      ).toBe(302);
    expect(stats.snapshot().totals).toEqual({ shortlink_x: 4 });

    // Each of these still lands (a preview shows the page), but isn't someone opening the link.
    const notVisits: Record<string, string>[] = [
      // No Sec-Fetch-Mode: a script, a preview fetcher, or a browser too old to send it.
      { "user-agent": SAFARI },
      { "user-agent": "WhatsApp/2.24.1.6 A" },
      { "user-agent": "curl/8.9.1" },
      // A page's fetch(), not a navigation.
      { "sec-fetch-mode": "cors", "user-agent": SAFARI },
      { "sec-fetch-mode": "navigate" },
      { "sec-fetch-mode": "navigate", "user-agent": "" },
      ...[
        "Twitterbot/1.0",
        "TelegramBot (like TwitterBot)",
        "facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)",
        "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
        "Slackbot-LinkExpanding 1.0 (+https://api.slack.com/robots)",
        "Mozilla/5.0 (compatible; Discordbot/2.0; +https://discordapp.com)",
        "Mozilla/5.0 (compatible; Bytespider; spider-feedback@bytedance.com)",
        "Mozilla/5.0 (compatible; Barkrowler/0.9; +https://babbar.tech/crawler)",
        "Mozilla/5.0 (Windows NT 6.1; WOW64) SkypeUriPreview Preview/0.5",
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/141.0.0.0 Safari/537.36",
      ].map((agent) => ({ "sec-fetch-mode": "navigate", "user-agent": agent })),
    ];
    for (const headers of notVisits) {
      const res = await get(app, "/x", headers);
      expect(res.status, JSON.stringify(headers)).toBe(302);
      expect(res.headers.get("location")).toBe("/?via=x");
    }
    expect((await get(app, "/x", BROWSER, "HEAD")).status).toBe(302);
    expect(stats.snapshot().totals).toEqual({ shortlink_x: 4 });
  });

  it("still land past the visitor's allowance, which events share", async () => {
    const stats = await counting();
    const app = createApp({
      bank,
      version: "9.9.9",
      stats,
      eventLimit: { perMinute: 3, trustProxy: true },
    });
    const from = (address: string) => ({ ...BROWSER, "x-forwarded-for": address });
    for (let i = 0; i < 5; i++)
      expect((await get(app, "/tt", from("203.0.113.7"))).status).toBe(302);
    expect(stats.snapshot().totals).toEqual({ shortlink_tt: 3 });

    const event = (address: string) =>
      app.request("/api/event", {
        method: "POST",
        headers: { origin: "http://localhost", "x-forwarded-for": address },
        body: '{"e":"quiz_start"}',
      });
    expect((await event("203.0.113.7")).status).toBe(429);
    // Another visitor still has a whole allowance.
    expect((await event("198.51.100.1")).status).toBe(204);
    expect((await get(app, "/tt", from("198.51.100.1"))).status).toBe(302);
    expect(stats.snapshot().totals).toEqual({ shortlink_tt: 4, quiz_start: 1 });
  });

  it("can't be counted through /api/event", async () => {
    const stats = await counting();
    const app = createApp({ bank, version: "9.9.9", stats });
    const res = await app.request("/api/event", {
      method: "POST",
      headers: { origin: "http://localhost" },
      body: '{"e":"shortlink_x"}',
    });
    expect(res.status).toBe(400);
    expect(stats.snapshot().totals).toEqual({});
  });

  it("land without counting on an instance that doesn't count", async () => {
    const app = createApp({ bank, version: "9.9.9" });
    const res = await get(app, "/ig");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?via=ig");
  });

  it("win over the page's own routes, and only for GET and HEAD", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "abtune-static-"));
    await writeFile(path.join(dir, "index.html"), "<p>page</p>");
    const app = createApp({ bank, version: "9.9.9", staticRoot: dir, stats: await counting() });
    expect((await get(app, "/x")).status).toBe(302);
    for (const route of ["/", "/xx", "/x/y", "/igloo"])
      expect((await get(app, route)).status, route).toBe(200);
    expect((await app.request("/x", { method: "POST", headers: BROWSER })).status).not.toBe(302);
  });

  it("keep their counts in the file across restarts", async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), "abtune-stats-")), "stats.json");
    const now = () => new Date("2026-10-11T12:00:00Z");
    const first = await Stats.open(file, now);
    first.count("shortlink_ig");
    first.count("quiz_done");
    await first.flush();
    expect((await Stats.open(file, now)).snapshot().totals).toEqual({
      shortlink_ig: 1,
      quiz_done: 1,
    });
  });
});
