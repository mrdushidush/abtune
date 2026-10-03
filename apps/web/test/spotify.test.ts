import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { CatalogManifest } from "@abtune/catalog";
import { loadCatalog } from "@abtune/catalog/reader";
import { missingSettings, redirectProblem, type SpotifySettings } from "@abtune/connectors/spotify";
import { FakeSpotify, type FakeTrack } from "@abtune/connectors/spotify/fake";
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
import type {
  PlaylistRequest,
  PlaylistResponse,
  SpotifyApiError,
  SpotifyPushRequest,
  SpotifyPushResponse,
  SpotifyStatus,
} from "../src/api-types.ts";
import { createApp } from "../src/server/app.ts";
import { catalogInfo, catalogSlot } from "../src/server/catalog.ts";
import { safeReturn, withOutcome } from "../src/server/spotify.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));
const SECRET = "0123456789abcdef0123456789abcdef-web-test";
const ORIGIN = "http://127.0.0.1:8787";

/** A cookie jar for `app.request`. */
class Jar {
  readonly cookies = new Map<string, string>();
  take(res: Response): Response {
    for (const line of res.headers.getSetCookie()) {
      const [pair] = line.split(";");
      const [name, ...rest] = (pair as string).split("=");
      const value = rest.join("=");
      if (/max-age=0/i.test(line) || value === "") this.cookies.delete(name as string);
      else this.cookies.set(name as string, value);
    }
    return res;
  }
  get header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }
}

describe("Spotify routes", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: repo("data/questions") });
  if (!bank) throw new Error("seed bank failed to load");
  const dir = repo("data/catalog-fixture");
  const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8")) as CatalogManifest;
  const loaded = await loadCatalog(dir, bank.dimensions, { threads: 2 });
  const tmp = await mkdtemp(path.join(tmpdir(), "abtune-web-spotify-"));
  afterAll(async () => {
    loaded.close();
    await rm(tmp, { recursive: true, force: true });
  });
  const info = catalogInfo(manifest);
  const slot = catalogSlot(info, Promise.resolve(loaded));
  await slot.settled;

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

  /** Spotify has the whole fixture catalog except `absent`. */
  const setup = async (absent: readonly string[] = []) => {
    const all = await loaded.meta(Array.from({ length: loaded.columns.n }, (_, i) => i));
    const tracks: FakeTrack[] = all
      .filter((m) => !absent.includes(m.track_id))
      .map((m, i) => ({
        id: `sp${i}`,
        name: m.title,
        artists: [m.artist_credit],
        ...(m.isrcs[0] ? { isrc: m.isrcs[0] } : {}),
      }));
    const fake = new FakeSpotify(tracks);
    const settings: SpotifySettings = {
      clientId: fake.clientId,
      redirectUri: `${ORIGIN}/callback`,
      secret: SECRET,
      tokenFile: path.join(tmp, `${Math.random().toString(36).slice(2)}.json`),
      accountsBase: "https://accounts.test",
      apiBase: "https://api.test/v1",
      fetch: fake.fetch,
      sleep: async () => {},
    };
    const app = createApp({ bank, version: "9.9.9", catalog: slot, spotify: settings });
    const jar = new Jar();
    const get = async (p: string) =>
      jar.take(await app.request(`${ORIGIN}${p}`, { headers: { cookie: jar.header } }));
    const post = async (p: string, body: unknown, headers: Record<string, string> = {}) =>
      jar.take(
        await app.request(`${ORIGIN}${p}`, {
          method: "POST",
          headers: { "content-type": "application/json", cookie: jar.header, ...headers },
          body: JSON.stringify(body),
        }),
      );
    /** Connect → Spotify (auto-approve) → /callback → back to `ret`. */
    const signIn = async (ret = "/") => {
      const login = await get(`/api/spotify/login?return=${encodeURIComponent(ret)}`);
      expect(login.status).toBe(302);
      const approved = await fake.handle(new Request(login.headers.get("location") as string));
      const back = new URL(approved.headers.get("location") as string);
      expect(back.origin + back.pathname).toBe(`${ORIGIN}/callback`);
      return get(back.pathname + back.search);
    };
    const playlist = async () => {
      const res = await app.request(`${ORIGIN}/api/playlist`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(request),
      });
      return (await res.json()) as PlaylistResponse;
    };
    const pushBody = (tracks: readonly string[]): SpotifyPushRequest => ({
      name: "Neon Nostalgist Radio",
      description: "Hits from the 80s",
      tracks,
      request,
    });
    return { fake, settings, app, jar, get, post, signIn, playlist, pushBody };
  };

  it("validates settings: Client ID, key length, loopback-or-https redirect", () => {
    const ok = {
      clientId: "0123456789abcdef0123456789abcdef",
      redirectUri: `${ORIGIN}/callback`,
      secret: SECRET,
      tokenFile: "x",
    };
    expect(missingSettings(ok)).toEqual([]);
    expect(missingSettings({ ...ok, clientId: "nope", secret: "short" })).toEqual([
      "SPOTIFY_CLIENT_ID",
      "TOKEN_ENCRYPTION_KEY",
    ]);
    expect(redirectProblem("http://localhost:8787/callback")).toBe(true);
    expect(redirectProblem("http://192.168.1.5:8787/callback")).toBe(true);
    expect(redirectProblem("https://abtune.example.com/callback")).toBe(false);
    expect(redirectProblem("http://[::1]:8787/callback")).toBe(false);
    expect(safeReturn("//evil.example")).toBe("/");
    expect(safeReturn("https://evil.example")).toBe("/");
    expect(safeReturn("/#s=abc")).toBe("/#s=abc");
    expect(withOutcome("/?x=1#s=abc", "connected")).toBe("/?x=1&spotify=connected#s=abc");
    // Paths the URL parser turns into `//host`, which a browser would follow off-site.
    for (const raw of ["/.//evil.example", "/%2e//evil.example", "/a/..//evil.example"]) {
      expect(safeReturn(raw)).not.toMatch(/^\/\//);
      expect(withOutcome(raw, "connected")).toMatch(/^\/[^/\\]/);
    }
  });

  it("never bounces a sign-in to another host", async () => {
    const app = createApp({ bank, version: "9.9.9" });
    for (const ret of ["/.//evil.example", "/%2e//evil.example/x", "/\t/evil.example"]) {
      const login = await app.request(
        `${ORIGIN}/api/spotify/login?return=${encodeURIComponent(ret)}`,
      );
      const location = login.headers.get("location") as string;
      expect(new URL(location, ORIGIN).origin).toBe(ORIGIN);
    }
  });

  it("reports an unconfigured server, and Connect bounces back", async () => {
    const app = createApp({ bank, version: "9.9.9" });
    const status = (await (await app.request("/api/spotify")).json()) as SpotifyStatus;
    expect(status).toEqual({
      configured: false,
      missing: ["SPOTIFY_CLIENT_ID", "TOKEN_ENCRYPTION_KEY"],
      redirect_uri: `${ORIGIN}/callback`,
      app_origin: ORIGIN,
      connected: null,
    });
    const login = await app.request(`${ORIGIN}/api/spotify/login?return=%2F`);
    expect(login.headers.get("location")).toBe("/?spotify=not_configured");
  });

  it("signs in with PKCE, stores the tokens encrypted, and pushes N songs privately", async () => {
    const s = await setup();
    const shown = await s.playlist();
    const ids = shown.tracks.map((t) => t.track_id);
    // Two songs Spotify doesn't have.
    const absent = [ids[3] as string, ids[17] as string];
    const t = await setup(absent);

    const back = await t.signIn("/?a=1#s=CODE");
    expect(back.status).toBe(302);
    expect(back.headers.get("location")).toBe("/?a=1&spotify=connected#s=CODE");
    expect(t.jar.cookies.has("abtune_spotify")).toBe(true);
    expect(back.headers.getSetCookie().join("\n")).toMatch(/abtune_spotify=.*HttpOnly/i);

    const status = (await (await t.get("/api/spotify")).json()) as SpotifyStatus;
    expect(status.connected).toEqual({ user_id: "fakeuser", display_name: "Fake Listener" });
    const raw = await readFile(t.settings.tokenFile, "utf8");
    expect(raw).not.toMatch(/fakeuser|Fake Listener|refresh_token/);
    expect(raw).not.toContain(t.jar.cookies.get("abtune_spotify") as string);

    const res = await t.post("/api/spotify/push", t.pushBody(ids), { origin: ORIGIN });
    expect(res.status).toBe(200);
    const report = (await res.json()) as SpotifyPushResponse;
    expect(report.requested).toBe(25);
    expect(report.added).toBe(25);
    expect(report.matched).toBe(23);
    expect(report.replaced.map((r) => r.position)).toEqual([3, 17]);
    expect(report.replaced.map((r) => r.missing.track_id)).toEqual(absent);
    for (const r of report.replaced) expect(ids).not.toContain(r.replacement.track_id);
    expect(report.missing).toEqual([]);
    expect(report.with_isrc_matched / report.with_isrc).toBeGreaterThanOrEqual(0.9);

    const [p] = [...t.fake.playlists.values()];
    expect(p).toMatchObject({ name: "Neon Nostalgist Radio", public: false });
    expect(p?.description).toBe("Hits from the 80s · Made with ABTune");
    expect(p?.items).toHaveLength(25);
    expect(report.playlist_url).toBe(`https://open.spotify.com/playlist/${p?.id}`);

    // The same push again gives the same replacements (seeded), from the match cache.
    const searches = t.fake.requests.filter((r) => r.path === "/search").length;
    const again = (await (
      await t.post("/api/spotify/push", t.pushBody(ids))
    ).json()) as SpotifyPushResponse;
    expect(again.replaced).toEqual(report.replaced);
    expect(t.fake.requests.filter((r) => r.path === "/search").length).toBe(searches);
  });

  it("refuses a callback that doesn't match a sign-in from this browser", async () => {
    const t = await setup();
    const login = await t.get("/api/spotify/login?return=%2F");
    const approved = await t.fake.handle(new Request(login.headers.get("location") as string));
    const back = new URL(approved.headers.get("location") as string);
    t.jar.cookies.delete("abtune_spotify_state");
    const res = await t.get(back.pathname + back.search);
    expect(res.headers.get("location")).toBe("/?spotify=expired");
    expect(t.jar.cookies.has("abtune_spotify")).toBe(false);
    const denied = await t.get("/callback?error=access_denied&state=nope");
    expect(denied.headers.get("location")).toBe("/?spotify=expired");
  });

  it("reports the user's denial and a user missing from the allowlist", async () => {
    const t = await setup();
    const login = await t.get("/api/spotify/login?return=%2F");
    const st = new URL(login.headers.get("location") as string).searchParams.get("state");
    const denied = await t.get(`/callback?error=access_denied&state=${st}`);
    expect(denied.headers.get("location")).toBe("/?spotify=denied");

    t.fake.allowlist = new Set(["somebody-else"]);
    const back = await t.signIn();
    expect(back.headers.get("location")).toBe("/?spotify=not_allowed");
    expect(t.jar.cookies.has("abtune_spotify")).toBe(false);
  });

  it("sends sign-in to the redirect URI's host, so the cookies match", async () => {
    const t = await setup();
    const res = await t.app.request("http://localhost:8787/api/spotify/login?return=%2F");
    expect(res.headers.get("location")).toBe(`${ORIGIN}/api/spotify/login?return=%2F`);
  });

  it("maps push errors: not connected, cross-site, quota, version mismatch", async () => {
    const t = await setup();
    const ids = (await t.playlist()).tracks.map((x) => x.track_id);
    const notConnected = await t.post("/api/spotify/push", t.pushBody(ids));
    expect(notConnected.status).toBe(401);
    expect(((await notConnected.json()) as SpotifyApiError).error).toBe("not_connected");

    await t.signIn();
    const cross = await t.post("/api/spotify/push", t.pushBody(ids), {
      origin: "https://evil.example",
    });
    expect(cross.status).toBe(403);

    const stale = await t.post("/api/spotify/push", {
      ...t.pushBody(ids),
      request: { ...request, catalog_version: "catalog-1999.01" },
    });
    expect(stale.status).toBe(409);

    const bad = await t.post("/api/spotify/push", { ...t.pushBody(ids), tracks: ["nope"] });
    expect(bad.status).toBe(400);

    t.fake.failures.push({ path: /^\/search$/, status: 429, body: { reason: "QUOTA_EXCEEDED" } });
    const quota = await t.post("/api/spotify/push", t.pushBody(ids));
    expect(quota.status).toBe(429);
    expect(((await quota.json()) as SpotifyApiError).error).toBe("quota_exceeded");
    expect(t.fake.playlists.size).toBe(0);
  });

  it("forgets a connection Spotify revoked, and disconnects", async () => {
    const t = await setup();
    const ids = (await t.playlist()).tracks.map((x) => x.track_id);
    await t.signIn();
    t.fake.revoke();
    const res = await t.post("/api/spotify/push", t.pushBody(ids));
    expect(res.status).toBe(401);
    expect(((await res.json()) as SpotifyApiError).error).toBe("not_connected");
    expect(t.jar.cookies.has("abtune_spotify")).toBe(false);

    await t.signIn();
    expect(
      ((await (await t.get("/api/spotify")).json()) as SpotifyStatus).connected,
    ).not.toBeNull();
    const out = await t.post("/api/spotify/disconnect", {});
    expect(out.status).toBe(200);
    expect(t.jar.cookies.has("abtune_spotify")).toBe(false);
    expect(JSON.parse(await readFile(t.settings.tokenFile, "utf8")).connections).toEqual({});
  });
});
