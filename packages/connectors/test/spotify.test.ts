import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { FakeSpotify, type FakeTrack } from "../src/spotify/fake.ts";
import {
  artistMatches,
  authorizeUrl,
  type Connection,
  entryKey,
  exchangeCode,
  isQuotaExceeded,
  MatchCache,
  newConnectionId,
  normTitle,
  type PushSong,
  pickBest,
  pkceChallenge,
  pkcePair,
  pushPlaylist,
  SpotifyClient,
  type SpotifyConfig,
  SpotifyError,
  StoredTokens,
  similarity,
  type TokenSource,
  TokenStore,
} from "../src/spotify/index.ts";

const SECRET = "test-secret-test-secret-test-secret-0123";
const dirs: string[] = [];
afterAll(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
});
const tempFile = async () => {
  const d = await mkdtemp(path.join(tmpdir(), "abtune-spotify-"));
  dirs.push(d);
  return path.join(d, "tokens.json");
};

function setup(tracks: readonly FakeTrack[] = []) {
  const fake = new FakeSpotify(tracks);
  const slept: number[] = [];
  const cfg: SpotifyConfig = {
    clientId: fake.clientId,
    redirectUri: "http://127.0.0.1:8787/callback",
    accountsBase: "https://accounts.test",
    apiBase: "https://api.test/v1",
    fetch: fake.fetch,
    sleep: async (ms) => {
      slept.push(ms);
    },
  };
  /** The whole sign-in: authorize (auto-approved) → callback code → token exchange. */
  const signIn = async () => {
    const { verifier, challenge } = pkcePair();
    const res = await fake.handle(new Request(authorizeUrl(cfg, { state: "st", challenge })));
    const back = new URL(res.headers.get("location") as string);
    expect(back.searchParams.get("state")).toBe("st");
    return exchangeCode(cfg, back.searchParams.get("code") as string, verifier);
  };
  return { fake, cfg, slept, signIn };
}

/** A token source over a sign-in, counting refreshes. */
async function tokensFor(s: ReturnType<typeof setup>) {
  let tokens = await s.signIn();
  const source: TokenSource & { refreshes: number } = {
    refreshes: 0,
    access: async () => tokens.access_token,
    refresh: async () => {
      source.refreshes++;
      const { refreshTokens } = await import("../src/spotify/auth.ts");
      tokens = await refreshTokens(s.cfg, tokens.refresh_token);
      return tokens.access_token;
    },
  };
  return source;
}

const song = (n: number, isrc = true): PushSong => ({
  track_id: `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`,
  title: `Song ${n}`,
  artist: `Artist ${n}`,
  isrcs: isrc ? [`USAAA26${String(n).padStart(5, "0")}`] : [],
});
const onSpotify = (s: PushSong, n: number): FakeTrack => ({
  id: `t${n}`,
  name: s.title,
  artists: [s.artist],
  ...(s.isrcs[0] ? { isrc: s.isrcs[0] } : {}),
});

describe("PKCE and the authorize URL", () => {
  it("matches the RFC 7636 S256 example", () => {
    expect(pkceChallenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe(
      "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    );
    const { verifier, challenge } = pkcePair();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(challenge).toBe(pkceChallenge(verifier));
  });

  it("asks for the playlist scopes only, with S256 and the loopback redirect", () => {
    const { cfg } = setup();
    const url = new URL(authorizeUrl(cfg, { state: "abc", challenge: "xyz" }));
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: cfg.clientId,
      redirect_uri: "http://127.0.0.1:8787/callback",
      code_challenge_method: "S256",
      code_challenge: "xyz",
      scope: "playlist-modify-private playlist-modify-public",
      state: "abc",
    });
  });

  it("exchanges a code only with the right verifier", async () => {
    const s = setup();
    const tokens = await s.signIn();
    expect(tokens.refresh_token).toBeTruthy();
    await expect(exchangeCode(s.cfg, "bogus", "v".repeat(43))).rejects.toMatchObject({
      kind: "not_connected",
    });
  });
});

describe("matching", () => {
  it("normalizes version noise, accents and Hebrew points", () => {
    expect(normTitle("Under Pressure - Remastered 2011")).toBe("under pressure");
    expect(normTitle("Crazy in Love (feat. JAY-Z)")).toBe("crazy in love");
    expect(normTitle("Déjà Vu [Radio Edit]")).toBe("deja vu");
    expect(normTitle("שִׁיר")).toBe("שיר");
    expect(similarity("hello", "hello")).toBe(1);
    expect(similarity("kitten", "sitting")).toBeCloseTo(1 - 3 / 7);
  });

  it("matches artists by any credited name", () => {
    expect(artistMatches("Simon & Garfunkel", ["Simon & Garfunkel"])).toBe(true);
    expect(artistMatches("Beyoncé feat. JAY‐Z", ["JAY-Z"])).toBe(true);
    expect(artistMatches("The Beatles", ["Beatles"])).toBe(true);
    expect(artistMatches("Adele", ["Dua Lipa"])).toBe(false);
  });

  it("accepts a text result only on title ≥ 0.85, a matching artist and no live swap", () => {
    const t = { title: "Hello", artist: "Adele", isrcs: [] };
    const item = (name: string, artist: string) => ({
      id: name,
      uri: `spotify:track:${name}`,
      name,
      artists: [{ name: artist }],
    });
    expect(pickBest(t, [item("Hello - Live at the BBC", "Adele")])).toBeNull();
    expect(pickBest(t, [item("Hello", "Lionel Richie")])).toBeNull();
    expect(pickBest(t, [item("Hello Goodbye", "Adele")])).toBeNull();
    const fifth = { title: "Symphony No. 5", artist: "Berliner Philharmoniker", isrcs: [] };
    expect(pickBest(fifth, [item("Symphony No. 9", "Berliner Philharmoniker")])).toBeNull();
    expect(pickBest(t, [item("Hello - 2015 Remaster", "Adele")])?.name).toBe(
      "Hello - 2015 Remaster",
    );
  });
});

describe("token store", () => {
  const conn = (name: string): Connection => ({
    access_token: `access-${name}`,
    refresh_token: `refresh-${name}`,
    expires_at: Date.now() + 3600_000,
    scope: "playlist-modify-private",
    user_id: name,
    display_name: name,
    connected_at: Date.now(),
  });

  it("encrypts entries: no token or cookie value in the file", async () => {
    const file = await tempFile();
    const store = new TokenStore(file, SECRET);
    const id = newConnectionId();
    const alice = conn("alice");
    await store.write(entryKey(id), alice);
    const raw = await readFile(file, "utf8");
    expect(raw).not.toContain("refresh-alice");
    expect(raw).not.toContain("alice");
    expect(raw).not.toContain(id);
    expect(await store.read(entryKey(id))).toEqual(alice);
    // Another key can't open it, and an entry copied under another key doesn't open (AAD).
    expect(await new TokenStore(file, `${SECRET}x`).read(entryKey(id))).toBeNull();
    const json = JSON.parse(raw);
    json.connections.other = json.connections[entryKey(id)];
    await writeFile(file, JSON.stringify(json));
    expect((await store.all()).map((e) => e.entry)).toEqual([entryKey(id)]);
    await store.remove(entryKey(id));
    expect(await store.read(entryKey(id))).toBeNull();
  });

  it("refuses a short key", () => {
    expect(() => new TokenStore("x", "short")).toThrow(SpotifyError);
  });

  it("refreshes an expired token and writes it back; forgets a revoked one", async () => {
    const s = setup();
    const tokens = await s.signIn();
    const store = new TokenStore(await tempFile(), SECRET);
    const entry = entryKey(newConnectionId());
    const c: Connection = {
      ...tokens,
      expires_at: 0,
      user_id: "fakeuser",
      display_name: "Fake",
      connected_at: 1,
    };
    await store.write(entry, c);
    const source = new StoredTokens(s.cfg, store, entry, c);
    const access = await source.access();
    expect(access).not.toBe(tokens.access_token);
    expect((await store.read(entry))?.access_token).toBe(access);
    expect((await store.read(entry))?.refresh_token).toBe(tokens.refresh_token);

    s.fake.revoke();
    await expect(source.refresh()).rejects.toMatchObject({ kind: "not_connected" });
    expect(await store.read(entry)).toBeNull();
  });
});

describe("Spotify client errors (§11.1)", () => {
  it("401: refreshes and retries once", async () => {
    const s = setup();
    const tokens = await tokensFor(s);
    const client = new SpotifyClient(s.cfg, tokens);
    s.fake.expireTokens();
    expect((await client.me()).id).toBe("fakeuser");
    expect(tokens.refreshes).toBe(1);

    s.fake.failures.push({ path: /^\/me$/, status: 401, times: 2 });
    await expect(client.me()).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("403: not on the allowlist", async () => {
    const s = setup();
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    s.fake.allowlist = new Set(["someone-else"]);
    await expect(client.me()).rejects.toMatchObject({
      kind: "forbidden",
      message: expect.stringContaining("may not be registered"),
    });
  });

  it("429: honors Retry-After, pausing every request; gives up on long waits", async () => {
    const s = setup();
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    s.fake.failures.push({ path: /^\/me$/, status: 429, headers: { "retry-after": "2" } });
    expect((await client.me()).id).toBe("fakeuser");
    expect(s.slept.length).toBe(1);
    expect(s.slept[0]).toBeGreaterThan(1500);

    s.fake.failures.push({ path: /^\/me$/, status: 429, headers: { "retry-after": "3600" } });
    await expect(client.me()).rejects.toMatchObject({ kind: "rate_limited", retryAfter: 3600 });
  });

  it("429 + QUOTA_EXCEEDED: stops at once", async () => {
    const s = setup();
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    s.fake.failures.push({
      path: /^\/me$/,
      status: 429,
      body: { error: { status: 429, message: "Quota exceeded", reason: "QUOTA_EXCEEDED" } },
      headers: { "retry-after": "1" },
    });
    const before = client.calls;
    await expect(client.me()).rejects.toMatchObject({ kind: "quota_exceeded" });
    expect(client.calls - before).toBe(1);
    expect(isQuotaExceeded({ reason: "QUOTA_EXCEEDED" })).toBe(true);
    expect(isQuotaExceeded({ error: { message: "rate limit" } })).toBe(false);
  });

  it("5xx: one retry, then an error", async () => {
    const s = setup();
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    s.fake.failures.push({ path: /^\/me$/, status: 502 });
    expect((await client.me()).id).toBe("fakeuser");
    s.fake.failures.push({ path: /^\/me$/, status: 503, times: 2 });
    await expect(client.me()).rejects.toMatchObject({ kind: "spotify_error", status: 503 });
  });
});

describe("push", () => {
  /** 150 songs: Spotify has all but every 20th; text search finds the ones without an ISRC. */
  const songs = Array.from({ length: 150 }, (_, i) => song(i, i % 7 !== 3));
  const present = songs.filter((_, i) => i % 20 !== 19);
  const spares = Array.from({ length: 40 }, (_, i) => song(1000 + i));
  const catalogTracks = [...present, ...spares.slice(0, 30)].map((s, i) => onSpotify(s, i));

  it("keeps N songs: backfills the missing ones in place, adds in batches of ≤ 100", async () => {
    const s = setup(catalogTracks);
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    let next = 0;
    const report = await pushPlaylist(client, {
      name: "My mix",
      description: "A test · Made with ABTune",
      songs,
      backfill: async (slots, exclude) =>
        slots.map(() => {
          const sp = spares[next++] ?? null;
          if (sp) expect(exclude.has(sp.track_id)).toBe(false);
          return sp;
        }),
    });
    expect(report.requested).toBe(150);
    expect(report.added).toBe(150);
    expect(report.matched).toBe(143);
    expect(report.replaced).toHaveLength(7);
    expect(report.missing).toEqual([]);
    expect(report.withIsrcMatched / report.withIsrc).toBeGreaterThanOrEqual(0.9);
    const [p] = [...s.fake.playlists.values()];
    expect(p).toMatchObject({ name: "My mix", public: false });
    expect(p?.items).toHaveLength(150);
    // In place: position 19 holds the first replacement.
    expect(p?.items[19]).toBe(`spotify:track:t${present.length}`);
    const adds = s.fake.requests.filter((r) => r.path.endsWith("/items"));
    expect(adds.map((r) => (r.body as { uris: string[] }).uris.length)).toEqual([100, 50]);
    expect(report.calls).toBeLessThan(150 * 2);
  });

  it("without replacements the playlist is short and says which songs are missing", async () => {
    const s = setup(catalogTracks);
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    const report = await pushPlaylist(client, {
      name: "x",
      description: "",
      songs: songs.slice(0, 40),
    });
    expect(report.added).toBe(38);
    // "Song 19" must not match "Song 190" or similar: numbers have to agree.
    expect(report.missing.map((m) => m.title)).toEqual(["Song 19", "Song 39"]);
  });

  it("counts two catalog songs that are the same Spotify track once", async () => {
    const a = song(1);
    const b = { ...song(2), isrcs: a.isrcs };
    const s = setup([onSpotify(a, 1)]);
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    const report = await pushPlaylist(client, { name: "x", description: "", songs: [a, b] });
    expect(report.added).toBe(1);
    expect(report.missing).toEqual([b]);
  });

  it("creates nothing when no song is on Spotify", async () => {
    const s = setup([]);
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    await expect(
      pushPlaylist(client, { name: "x", description: "", songs: [song(1)] }),
    ).rejects.toMatchObject({ kind: "no_matches" });
    expect(s.fake.playlists.size).toBe(0);
  });

  it("stops on QUOTA_EXCEEDED before creating anything", async () => {
    const s = setup(catalogTracks);
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    s.fake.failures.push({ path: /^\/search$/, status: 429, body: { reason: "QUOTA_EXCEEDED" } });
    await expect(
      pushPlaylist(client, { name: "x", description: "", songs: songs.slice(0, 10) }),
    ).rejects.toMatchObject({ kind: "quota_exceeded" });
    expect(s.fake.playlists.size).toBe(0);
  });

  it("reports the playlist when filling it fails part way", async () => {
    const s = setup(catalogTracks);
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    s.fake.failures.push({ path: /\/items$/, status: 403, body: { error: { message: "nope" } } });
    const err = await pushPlaylist(client, {
      name: "x",
      description: "",
      songs: songs.slice(0, 5),
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SpotifyError);
    expect((err as SpotifyError).partial?.url).toMatch(/^https:\/\/open\.spotify\.com\/playlist\//);
  });

  it("caches matches per account, misses included", async () => {
    const s = setup(catalogTracks);
    const client = new SpotifyClient(s.cfg, await tokensFor(s));
    const cache = new MatchCache();
    const opts = { name: "x", description: "", songs: songs.slice(0, 10), cache, account: "u1" };
    await pushPlaylist(client, opts);
    const searches = () => s.fake.requests.filter((r) => r.path === "/search").length;
    const before = searches();
    await pushPlaylist(client, opts);
    expect(searches()).toBe(before);
    await pushPlaylist(client, { ...opts, account: "u2" });
    expect(searches()).toBeGreaterThan(before);
  });
});
