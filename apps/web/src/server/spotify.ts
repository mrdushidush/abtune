// Spotify for the web app (HANDOFF §11.1): sign-in (Authorization Code + PKCE) on the server, the
// connection stored encrypted (TOKEN_ENCRYPTION_KEY) and named by an HttpOnly cookie, and the push.
// Tokens never reach the browser or a log line.
import { randomBytes } from "node:crypto";
import {
  authorizeUrl,
  type Connection,
  catalogBackfill,
  DEFAULT_REDIRECT_URI,
  entryKey,
  exchangeCode,
  isSpotifyError,
  MatchCache,
  missingSettings,
  newConnectionId,
  type PushSong,
  pkcePair,
  playlistDescription,
  pushPlaylist,
  redirectProblem,
  SpotifyClient,
  SpotifyError,
  type SpotifySettings,
  StoredTokens,
  spotifyConfig,
  TokenStore,
} from "@abtune/connectors/spotify";
import type { Bank } from "@abtune/engine";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  MAX_PREVIOUS,
  type SpotifyApiError,
  type SpotifyErrorCode,
  type SpotifyOutcome,
  type SpotifyPushRequest,
  type SpotifyPushResponse,
  type SpotifyStatus,
} from "../api-types.ts";
import { type CatalogSlot, readyCatalog } from "./catalog.ts";
import { sameOrigin } from "./http.ts";
import { type Parsed, parsePlaylistRequest } from "./playlist.ts";

const COOKIE = "abtune_spotify";
const STATE_COOKIE = "abtune_spotify_state";
/** How long a sign-in may take between leaving for Spotify and coming back. */
const LOGIN_TTL_MS = 10 * 60 * 1000;
const PUSH_BODY_MAX = 32 * 1024;

/** A same-site path to come back to: never another origin. */
export function safeReturn(raw: string | undefined): string {
  if (
    !raw ||
    raw.length > 4096 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.includes("\\")
  )
    return "/";
  return raw;
}

/** `/path?x#h` + `spotify=outcome` → `/path?x&spotify=outcome#h`. */
export function withOutcome(ret: string, outcome: SpotifyOutcome): string {
  const u = new URL(ret, "http://x");
  u.searchParams.set("spotify", outcome);
  return `${u.pathname}${u.search}${u.hash}`;
}

const STATUS: Record<SpotifyErrorCode, 401 | 403 | 409 | 422 | 429 | 502 | 503> = {
  not_configured: 503,
  not_connected: 401,
  unauthorized: 401,
  forbidden: 403,
  rate_limited: 429,
  quota_exceeded: 429,
  no_matches: 422,
  network: 502,
  spotify_error: 502,
  busy: 409,
};

export function parsePushRequest(
  body: unknown,
  dims: Bank["dimensions"],
): Parsed<SpotifyPushRequest> {
  if (typeof body !== "object" || body === null || Array.isArray(body))
    return { ok: false, message: "Body must be a JSON object." };
  const b = body as Record<string, unknown>;
  if (typeof b.name !== "string" || b.name.trim() === "" || b.name.length > 200)
    return { ok: false, message: "name must be a non-empty string." };
  if (typeof b.description !== "string" || b.description.length > 1000)
    return { ok: false, message: "description must be a string." };
  if (b.public !== undefined && typeof b.public !== "boolean")
    return { ok: false, message: "public must be a boolean." };
  const tracks = b.tracks;
  if (
    !Array.isArray(tracks) ||
    tracks.length === 0 ||
    tracks.length > MAX_PREVIOUS ||
    !tracks.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id)) ||
    new Set(tracks).size !== tracks.length
  )
    return { ok: false, message: `tracks must be 1–${MAX_PREVIOUS} distinct track ids.` };
  const request = parsePlaylistRequest(b.request, dims);
  if (!request.ok) return { ok: false, message: `request: ${request.message}` };
  return {
    ok: true,
    value: {
      name: b.name,
      description: b.description,
      public: b.public === true,
      tracks: tracks as string[],
      request: request.value,
    },
  };
}

function toResponse(r: Awaited<ReturnType<typeof pushPlaylist>>): SpotifyPushResponse {
  const song = (s: PushSong) => ({ track_id: s.track_id, title: s.title, artist: s.artist });
  return {
    playlist_url: r.playlist.url,
    name: r.playlist.name,
    requested: r.requested,
    added: r.added,
    matched: r.matched,
    by_isrc: r.byIsrc,
    with_isrc: r.withIsrc,
    with_isrc_matched: r.withIsrcMatched,
    replaced: r.replaced.map((x) => ({
      position: x.position,
      missing: song(x.missing),
      replacement: song(x.replacement),
    })),
    missing: r.missing.map(song),
  };
}

export function mountSpotify(
  app: Hono,
  {
    settings,
    bank,
    catalog,
    engine,
  }: { settings: SpotifySettings; bank: Bank; catalog: CatalogSlot | null; engine: string },
): void {
  const missing = missingSettings(settings);
  const configured = missing.length === 0;
  const cfg = spotifyConfig(settings);
  const store = configured ? new TokenStore(settings.tokenFile, settings.secret) : null;
  const redirect = redirectProblem(settings.redirectUri) ? null : new URL(settings.redirectUri);
  const appOrigin = redirect?.origin ?? new URL(DEFAULT_REDIRECT_URI).origin;
  const secure = redirect?.protocol === "https:";
  /** Sign-ins in progress, by state. */
  const pending = new Map<string, { verifier: string; ret: string; at: number }>();
  /** Connection entries with a push running (one at a time per browser). */
  const busy = new Set<string>();
  const cache = new MatchCache();

  const cookieOpts = (maxAge: number) =>
    ({ httpOnly: true, sameSite: "Lax", path: "/", secure, maxAge }) as const;
  const spotifyFail = (c: Context, code: SpotifyErrorCode, extra: Partial<SpotifyApiError> = {}) =>
    c.json({ error: code, ...extra } satisfies SpotifyApiError, STATUS[code]);

  /** This browser's stored connection, if any. */
  async function connection(c: Context): Promise<{ entry: string; conn: Connection } | null> {
    const id = getCookie(c, COOKIE);
    if (!store || !id) return null;
    const entry = entryKey(id);
    try {
      const conn = await store.read(entry);
      return conn ? { entry, conn } : null;
    } catch (err) {
      console.error(`Spotify: can't read ${store.file}: ${(err as Error).message}`);
      return null;
    }
  }

  app.get("/api/spotify", async (c) => {
    const found = await connection(c);
    return c.json({
      configured,
      missing,
      redirect_uri: settings.redirectUri,
      app_origin: appOrigin,
      connected: found
        ? { user_id: found.conn.user_id, display_name: found.conn.display_name }
        : null,
    } satisfies SpotifyStatus);
  });

  app.get("/api/spotify/login", (c) => {
    const ret = safeReturn(c.req.query("return"));
    if (!configured || !redirect) return c.redirect(withOutcome(ret, "not_configured"));
    // Cookies belong to one host: sign in from the redirect URI's host, or the callback can't
    // find this sign-in.
    if (new URL(c.req.url).host !== redirect.host)
      return c.redirect(`${appOrigin}/api/spotify/login?return=${encodeURIComponent(ret)}`);
    const now = Date.now();
    for (const [k, v] of pending) if (now - v.at > LOGIN_TTL_MS) pending.delete(k);
    if (pending.size > 100) pending.delete(pending.keys().next().value as string);
    const state = randomBytes(16).toString("base64url");
    const { verifier, challenge } = pkcePair();
    pending.set(state, { verifier, ret, at: now });
    setCookie(c, STATE_COOKIE, state, cookieOpts(LOGIN_TTL_MS / 1000));
    return c.redirect(authorizeUrl(cfg, { state, challenge }));
  });

  if (redirect)
    app.get(redirect.pathname, async (c) => {
      const state = c.req.query("state") ?? "";
      const cookieState = getCookie(c, STATE_COOKIE);
      deleteCookie(c, STATE_COOKIE, { path: "/", secure });
      const login = pending.get(state);
      pending.delete(state);
      if (!store || !login || state !== cookieState || Date.now() - login.at > LOGIN_TTL_MS)
        return c.redirect(withOutcome(login?.ret ?? "/", "expired"));
      const error = c.req.query("error");
      const code = c.req.query("code");
      if (error || !code)
        return c.redirect(withOutcome(login.ret, error === "access_denied" ? "denied" : "error"));
      try {
        const tokens = await exchangeCode(cfg, code, login.verifier);
        const once = {
          access: async () => tokens.access_token,
          refresh: async (): Promise<string> => {
            throw new SpotifyError("unauthorized", "Spotify didn't accept the new sign-in.");
          },
        };
        const me = await new SpotifyClient(cfg, once).me();
        // One connection per browser: signing in again replaces the old one.
        const old = getCookie(c, COOKIE);
        if (old) await store.remove(entryKey(old));
        const id = newConnectionId();
        await store.write(entryKey(id), {
          ...tokens,
          user_id: me.id,
          display_name: me.display_name,
          connected_at: Date.now(),
        });
        setCookie(c, COOKIE, id, cookieOpts(365 * 24 * 3600));
        return c.redirect(withOutcome(login.ret, "connected"));
      } catch (err) {
        const kind = isSpotifyError(err) ? err.kind : "internal";
        console.error(
          `Spotify sign-in failed (${kind})${isSpotifyError(err) ? "" : `: ${(err as Error).message}`}`,
        );
        return c.redirect(withOutcome(login.ret, kind === "forbidden" ? "not_allowed" : "error"));
      }
    });

  app.post("/api/spotify/disconnect", async (c) => {
    if (!sameOrigin(c)) return c.json({ error: "cross_site" } satisfies SpotifyApiError, 403);
    const found = await connection(c);
    if (found && store) await store.remove(found.entry);
    deleteCookie(c, COOKIE, { path: "/", secure });
    return c.json({ ok: true });
  });

  // The body is track ids, a profile and a name: never logged (HANDOFF §13).
  app.post(
    "/api/spotify/push",
    bodyLimit({
      maxSize: PUSH_BODY_MAX,
      onError: (c) => c.json({ error: "too_large" } satisfies SpotifyApiError, 413),
    }),
    async (c) => {
      if (!sameOrigin(c)) return c.json({ error: "cross_site" } satisfies SpotifyApiError, 403);
      if (!configured || !store) return spotifyFail(c, "not_configured");
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "bad_request", message: "Body must be JSON." }, 400);
      }
      const parsed = parsePushRequest(body, bank.dimensions);
      if (!parsed.ok)
        return c.json(
          { error: "bad_request", message: parsed.message } satisfies SpotifyApiError,
          400,
        );
      const req = parsed.value;
      const found = await connection(c);
      if (!found) {
        deleteCookie(c, COOKIE, { path: "/", secure });
        return spotifyFail(c, "not_connected");
      }
      const ready = readyCatalog(catalog, req.request, engine);
      if (!ready.ok) return c.json(ready.body, ready.status);
      const loaded = ready.catalog;
      const indices = req.tracks.map((id) => loaded.indexOf(id));
      if (indices.some((i) => i < 0))
        return c.json({ error: "bad_request", message: "tracks has unknown track ids." }, 400);
      if (busy.has(found.entry)) return spotifyFail(c, "busy");
      busy.add(found.entry);
      try {
        const meta = await loaded.meta(indices);
        const songs: PushSong[] = meta.map((m) => ({
          track_id: m.track_id,
          title: m.title,
          artist: m.artist_credit,
          isrcs: m.isrcs,
        }));
        const tokens = new StoredTokens(cfg, store, found.entry, found.conn);
        const report = await pushPlaylist(new SpotifyClient(cfg, tokens), {
          name: req.name,
          description: playlistDescription(req.description),
          public: req.public ?? false,
          songs,
          backfill: catalogBackfill(loaded, {
            taste: req.request.taste,
            seed: req.request.seed,
            length: req.request.length,
            swap: false,
          }),
          cache,
          account: found.conn.user_id,
        });
        return c.json(toResponse(report));
      } catch (err) {
        if (!isSpotifyError(err)) throw err;
        console.error(`Spotify push failed (${err.kind}${err.status ? ` ${err.status}` : ""})`);
        if (err.kind === "not_connected") deleteCookie(c, COOKIE, { path: "/", secure });
        if (err.kind === "rate_limited" && err.retryAfter !== null)
          c.header("Retry-After", String(err.retryAfter));
        return spotifyFail(c, err.kind, {
          message: err.message,
          ...(err.retryAfter !== null ? { retry_after: err.retryAfter } : {}),
          ...(err.partial ? { playlist_url: err.partial.url } : {}),
        });
      } finally {
        busy.delete(found.entry);
      }
    },
  );
}
