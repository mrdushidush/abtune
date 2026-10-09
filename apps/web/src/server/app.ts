import { readFile } from "node:fs/promises";
import path from "node:path";
import { AI_OFF } from "@abtune/ai";
import {
  missingSettings,
  type SpotifySettings,
  unconfiguredSpotify,
} from "@abtune/connectors/spotify";
import { type Bank, engineVersion } from "@abtune/engine";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import type { ApiError, Health } from "../api-types.ts";
import { aiHealth, mountAi, type ServerAi } from "./ai.ts";
import { type CatalogSlot, catalogHealth, readyCatalog } from "./catalog.ts";
import { sameOrigin } from "./http.ts";
import { buildPlaylist, parsePlaylistRequest, UnknownTrackError } from "./playlist.ts";
import { type RateLimitSettings, rateLimit } from "./ratelimit.ts";
import { mountSpotify } from "./spotify.ts";
import { isStatEvent, type Stats } from "./stats.ts";

export interface AppOptions {
  readonly bank: Bank;
  readonly version: string;
  /** Built SPA directory (relative to cwd or absolute). Omit to serve the API only. */
  readonly staticRoot?: string;
  /** The installed music catalog, if any (`abtune catalog fetch` or a full build). */
  readonly catalog?: CatalogSlot | null;
  /** Spotify settings from `.env` (HANDOFF §11.1). Omitted: Spotify isn't set up. */
  readonly spotify?: SpotifySettings;
  /** The AI layer (HANDOFF §10). Omitted: off. */
  readonly ai?: ServerAi;
  /**
   * Host names this server answers to besides loopback and IP addresses: APP_BASE_URL's and
   * SPOTIFY_REDIRECT_URI's (a reverse proxy's public name).
   */
  readonly hosts?: readonly string[];
  /** Where share links and link previews point (`shareBaseUrl`); ends with "/". */
  readonly publicUrl?: string;
  /** Usage counters (STATS_FILE). Omitted: none are kept and /api/event doesn't exist. */
  readonly stats?: Stats | null;
  /** Playlists per visitor (PLAYLISTS_PER_MINUTE). Omitted: no limit. */
  readonly playlistLimit?: RateLimitSettings | null;
}

/** The public instance: where share links from a loopback or home-network install point. */
export const PUBLIC_INSTANCE_URL = "https://abtune.com/";

/**
 * Where share links (and link previews) point: SHARE_BASE_URL, else APP_BASE_URL when it is a
 * public name, else the public instance. A link opened on another server rebuilds the playlist
 * from that server's catalog.
 */
export function shareBaseUrl(appBaseUrl?: string, shareBase?: string): string {
  const candidates: [string | undefined, boolean][] = [
    [shareBase, false],
    [appBaseUrl, true],
  ];
  for (const [u, mustBePublic] of candidates) {
    if (!u) continue;
    let url: URL;
    try {
      url = new URL(u);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    // Loopback names, IP addresses and dotless (home network) names can't be opened elsewhere.
    if (mustBePublic && (knownHost(url.hostname, new Set()) || !url.hostname.includes(".")))
      continue;
    return `${url.origin}${url.pathname.replace(/\/*$/, "/")}`;
  }
  return PUBLIC_INSTANCE_URL;
}

/** In the built index.html: replaced with the public URL (link-preview tags need absolute URLs). */
export const URL_PLACEHOLDER = "__ABTUNE_URL__";

const attr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * A host a browser may reach this server by. DNS rebinding points a site's own name at this
 * machine, so its pages would pass the Origin check; it needs a name the attacker controls, so
 * loopback names, IP addresses and the configured hosts are safe.
 */
export function knownHost(hostname: string, hosts: ReadonlySet<string>): boolean {
  const h = hostname.toLowerCase();
  return (
    h === "localhost" ||
    h.endsWith(".localhost") ||
    /^\d{1,3}(\.\d{1,3}){3}$/.test(h) ||
    h.startsWith("[") ||
    hosts.has(h)
  );
}

/** Security headers, with a strict CSP: the built SPA has no inline script or style. */
const SECURITY_HEADERS = secureHeaders({
  contentSecurityPolicy: {
    defaultSrc: ["'self'"],
    scriptSrc: ["'self'"],
    styleSrc: ["'self'"],
    // The share card preview is a blob: URL.
    imgSrc: ["'self'", "blob:"],
    connectSrc: ["'self'"],
    objectSrc: ["'none'"],
    baseUri: ["'none'"],
    formAction: ["'self'"],
    frameAncestors: ["'none'"],
  },
  xFrameOptions: "DENY",
  // Not no-referrer: under it browsers send `Origin: null` on same-origin POSTs, which the
  // cross-site check refuses.
  referrerPolicy: "same-origin",
  // HTTPS, and so HSTS, is the reverse proxy's business.
  strictTransportSecurity: false,
});

/** A playlist request is a taste vector and a few strings: well under this. */
export const MAX_BODY_BYTES = 16 * 1024;
/** An event report is one name. */
export const MAX_EVENT_BYTES = 256;

export function packCounts(bank: Bank): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of Object.keys(bank.packs)) counts[name] = 0;
  for (const q of bank.questions) counts[q.pack] = (counts[q.pack] ?? 0) + 1;
  return counts;
}

const fail = (c: Context, status: 400 | 403 | 404 | 409 | 413 | 503, body: ApiError) =>
  c.json(body, status);

export function createApp({
  bank,
  version,
  staticRoot,
  catalog = null,
  spotify = unconfiguredSpotify(),
  ai = { settings: AI_OFF, runtime: null },
  hosts = [],
  publicUrl = PUBLIC_INSTANCE_URL,
  stats = null,
  playlistLimit = null,
}: AppOptions): Hono {
  const app = new Hono();
  const engine = engineVersion(bank);
  const known = new Set(hosts.map((h) => h.toLowerCase()));

  app.use("*", async (c, next) => {
    const host = new URL(c.req.url).hostname;
    if (!knownHost(host, known))
      return fail(c, 403, {
        error: "unknown_host",
        message: `This server doesn't answer to ${host}. Set APP_BASE_URL to the address you open it at.`,
      });
    await next();
  });
  app.use("*", SECURITY_HEADERS);

  app.get("/api/health", (c) =>
    c.json({
      name: "ABTune",
      version,
      engine_version: engine,
      questions: bank.questions.length,
      packs: packCounts(bank),
      catalog: catalogHealth(catalog),
      ai: aiHealth(ai),
      spotify: { configured: missingSettings(spotify).length === 0 },
      share_url: publicUrl,
      stats: stats !== null,
    } satisfies Health),
  );

  // The body is never logged: it is a profile, and the server keeps no record of it (HANDOFF §13).
  // One core builds about two playlists a second, so one visitor in a loop could take them all.
  if (playlistLimit) app.use("/api/playlist", rateLimit(playlistLimit));
  app.post(
    "/api/playlist",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, { error: "too_large", message: "Request body too large." }),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return fail(c, 400, { error: "bad_request", message: "Body must be JSON." });
      }
      const parsed = parsePlaylistRequest(body, bank.dimensions);
      if (!parsed.ok) return fail(c, 400, { error: "bad_request", message: parsed.message });
      const req = parsed.value;
      const ready = readyCatalog(catalog, req, engine);
      if (!ready.ok) {
        if (ready.body.error === "catalog_loading") c.header("Retry-After", "2");
        return c.json(ready.body, ready.status);
      }
      try {
        return c.json(
          await buildPlaylist(ready.catalog, req, engine, {
            runtime: ai.runtime,
            rerank: ai.settings.rerank,
            signal: c.req.raw.signal,
          }),
        );
      } catch (err) {
        if (err instanceof UnknownTrackError)
          return fail(c, 400, { error: "bad_request", message: "previous has unknown track ids." });
        throw err;
      }
    },
  );

  mountSpotify(app, { settings: spotify, bank, catalog, engine });
  mountAi(app, { ai, bank, engine });

  if (stats) {
    // A name from STAT_EVENTS and nothing else: the count is all that's kept.
    app.post(
      "/api/event",
      bodyLimit({
        maxSize: MAX_EVENT_BYTES,
        onError: (c) => fail(c, 413, { error: "too_large", message: "Request body too large." }),
      }),
      async (c) => {
        if (!sameOrigin(c)) return fail(c, 403, { error: "cross_site" });
        let event: unknown;
        try {
          // Sent as text/plain (sendBeacon), so it's parsed here.
          event = (JSON.parse(await c.req.text()) as { e?: unknown } | null)?.e;
        } catch {
          event = undefined;
        }
        if (!isStatEvent(event))
          return fail(c, 400, { error: "bad_request", message: "Unknown event." });
        stats.count(event);
        return c.body(null, 204);
      },
    );
    app.get("/api/stats", (c) => {
      c.header("Cache-Control", "no-store");
      return c.json(stats.snapshot());
    });
  }

  app.all("/api/*", (c) => fail(c, 404, { error: "not_found" }));

  if (staticRoot !== undefined) {
    // index.html with the public URL filled in, read once.
    let index: Promise<string | null> | null = null;
    const page = async (c: Context) => {
      index ??= readFile(path.join(staticRoot, "index.html"), "utf8").then(
        (html) => html.replaceAll(URL_PLACEHOLDER, attr(publicUrl)),
        () => null,
      );
      const html = await index;
      if (html === null) return c.text("Not found", 404);
      c.header("Cache-Control", "no-cache");
      return c.html(html);
    };
    app.get("/", page);
    app.get("/index.html", page);
    // Built assets have content hashes in their names: cache them for good.
    app.use("/assets/*", async (c, next) => {
      await next();
      if (c.res.status === 200) c.header("Cache-Control", "public, max-age=31536000, immutable");
    });
    app.use("/*", serveStatic({ root: staticRoot }));
    // SPA fallback: client-side routes get index.html.
    app.get("*", page);
  }

  return app;
}
