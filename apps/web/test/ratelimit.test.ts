import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { describe, expect, it } from "vitest";
import { retryAfterMs } from "../src/client/state/api.ts";
import { createApp } from "../src/server/app.ts";
import { addressKey, RateLimiter, rateLimitSettings } from "../src/server/ratelimit.ts";

const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));

describe("RateLimiter", () => {
  const clock = () => {
    let t = 1_000_000;
    return { now: () => t, advance: (ms: number) => (t += ms) };
  };

  it("allows a minute's worth at once, then one per 60/n seconds", () => {
    const c = clock();
    const limiter = new RateLimiter(20, c.now);
    for (let i = 0; i < 20; i++) expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(3);
    c.advance(2_000);
    expect(limiter.take("a")).toBe(1);
    c.advance(1_000);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(3);
  });

  it("keeps visitors apart", () => {
    const limiter = new RateLimiter(1, clock().now);
    expect(limiter.take("a")).toBe(0);
    expect(limiter.take("a")).toBe(60);
    expect(limiter.take("b")).toBe(0);
  });

  it("forgets visitors once their bucket is full again", () => {
    const c = clock();
    const limiter = new RateLimiter(5, c.now);
    limiter.take("a");
    limiter.take("b");
    c.advance(30_000);
    limiter.take("c");
    expect(limiter.size).toBe(3);
    c.advance(30_000);
    limiter.take("c");
    expect(limiter.size).toBe(1);
  });
});

describe("addressKey", () => {
  it("keeps IPv4 and unwraps IPv4-mapped IPv6", () => {
    expect(addressKey("203.0.113.7")).toBe("203.0.113.7");
    expect(addressKey("::ffff:203.0.113.7")).toBe("203.0.113.7");
  });

  it("cuts IPv6 to its /64", () => {
    expect(addressKey("2001:db8:abcd:12:1:2:3:4")).toBe("2001:db8:abcd:12::/64");
    expect(addressKey("2001:0DB8:abcd:0012:ffff::1")).toBe("2001:db8:abcd:12::/64");
    expect(addressKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(addressKey("fe80::1%eth0")).toBe("fe80:0:0:0::/64");
    expect(addressKey("::1")).toBe("0:0:0:0::/64");
  });
});

describe("rateLimitSettings", () => {
  it("is off unless PLAYLISTS_PER_MINUTE is set", () => {
    expect(rateLimitSettings({})).toEqual({ settings: null, problem: null });
    expect(rateLimitSettings({ PLAYLISTS_PER_MINUTE: " " })).toEqual({
      settings: null,
      problem: null,
    });
  });

  it("reads the limit and TRUST_PROXY", () => {
    expect(rateLimitSettings({ PLAYLISTS_PER_MINUTE: "20" }).settings).toEqual({
      perMinute: 20,
      trustProxy: false,
    });
    expect(
      rateLimitSettings({ PLAYLISTS_PER_MINUTE: "20", TRUST_PROXY: "true" }).settings?.trustProxy,
    ).toBe(true);
  });

  it("reports a bad limit and stays off", () => {
    for (const v of ["0", "-3", "1.5", "lots"]) {
      const r = rateLimitSettings({ PLAYLISTS_PER_MINUTE: v });
      expect(r.settings).toBeNull();
      expect(r.problem).toMatch(/PLAYLISTS_PER_MINUTE/);
    }
  });
});

describe("POST /api/playlist with PLAYLISTS_PER_MINUTE", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
  if (!bank) throw new Error("seed bank failed to load");
  // No catalog: the requests that get through are 503s, which still count.
  const post = (app: ReturnType<typeof createApp>, forwardedFor?: string) =>
    app.request("/api/playlist", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(forwardedFor ? { "x-forwarded-for": forwardedFor } : {}),
      },
      body: "{}",
    });

  it("answers 429 rate_limited with Retry-After once a visitor runs out", async () => {
    const app = createApp({
      bank,
      version: "9.9.9",
      playlistLimit: { perMinute: 2, trustProxy: true },
    });
    expect((await post(app, "203.0.113.7")).status).not.toBe(429);
    expect((await post(app, "203.0.113.7")).status).not.toBe(429);
    const res = await post(app, "203.0.113.7");
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("30");
    expect(await res.json()).toMatchObject({ error: "rate_limited", retry_after: 30 });
    // Another visitor, and other routes, are not affected.
    expect((await post(app, "198.51.100.1")).status).not.toBe(429);
    expect((await app.request("/api/health")).status).toBe(200);
  });

  it("takes the proxy's address, the last in X-Forwarded-For, not one the visitor sent", async () => {
    const app = createApp({
      bank,
      version: "9.9.9",
      playlistLimit: { perMinute: 1, trustProxy: true },
    });
    expect((await post(app, "10.0.0.1, 203.0.113.7")).status).not.toBe(429);
    expect((await post(app, "10.0.0.2, 203.0.113.7")).status).toBe(429);
  });

  it("ignores X-Forwarded-For without TRUST_PROXY", async () => {
    const app = createApp({
      bank,
      version: "9.9.9",
      playlistLimit: { perMinute: 1, trustProxy: false },
    });
    expect((await post(app, "203.0.113.7")).status).not.toBe(429);
    expect((await post(app, "198.51.100.1")).status).toBe(429);
  });

  it("has no limit unless one is set", async () => {
    const app = createApp({ bank, version: "9.9.9" });
    for (let i = 0; i < 30; i++) expect((await post(app, "203.0.113.7")).status).not.toBe(429);
  });
});

describe("retryAfterMs (client)", () => {
  it("waits what the server says, between 1 s and a minute", () => {
    expect(retryAfterMs({ error: "rate_limited", retry_after: 3 })).toBe(3_000);
    expect(retryAfterMs({ error: "rate_limited", retry_after: 600 })).toBe(60_000);
    expect(retryAfterMs({ error: "rate_limited", retry_after: 0 })).toBe(1_000);
    expect(retryAfterMs(null)).toBe(3_000);
  });
});
