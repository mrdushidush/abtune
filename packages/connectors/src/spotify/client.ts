// The few Web API calls ABTune makes, with HANDOFF §11.1's error handling: 401 → refresh and
// retry once, 403 → allowlist/Premium, 429 → honor Retry-After, 429 + QUOTA_EXCEEDED → stop.
import { API_BASE, type SpotifyConfig } from "./auth.ts";
import { SpotifyError } from "./errors.ts";

/** Where the client gets its bearer token. */
export interface TokenSource {
  /** A usable access token (refreshed shortly before it expires). */
  access(): Promise<string>;
  /** A new access token after Spotify answered 401. */
  refresh(): Promise<string>;
}

export interface SpotifyUser {
  readonly id: string;
  readonly display_name: string | null;
}

export interface SpotifyTrack {
  readonly id: string;
  readonly uri: string;
  readonly name: string;
  readonly artists: readonly { readonly name: string }[];
  readonly duration_ms?: number;
}

export interface CreatedPlaylist {
  readonly id: string;
  readonly uri: string;
  /** open.spotify.com link. */
  readonly url: string;
  readonly name: string;
}

/** Spotify's search `limit` maximum since February 2026. */
export const SEARCH_LIMIT_MAX = 10;
/** URIs per add-items request. */
export const ADD_BATCH = 100;
/** The longest Retry-After we sit out; longer ones end the push with `rate_limited`. */
export const MAX_RETRY_AFTER_S = 30;

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class SpotifyClient {
  /** HTTP requests made, retries included (the §11.1 call budget). */
  calls = 0;
  private readonly cfg: SpotifyConfig;
  private readonly tokens: TokenSource;
  /** A 429 pauses every request of this client, not just the one that got it. */
  private pausedUntil = 0;

  constructor(cfg: SpotifyConfig, tokens: TokenSource) {
    this.cfg = cfg;
    this.tokens = tokens;
  }

  me(): Promise<SpotifyUser> {
    return this.request<SpotifyUser>("GET", "/me");
  }

  /** Tracks playable in the user's market, best first. */
  async searchTracks(q: string, limit: number): Promise<SpotifyTrack[]> {
    const body = await this.request<{ tracks?: { items?: (SpotifyTrack | null)[] } }>(
      "GET",
      "/search",
      {
        q,
        type: "track",
        limit: String(Math.min(Math.max(1, limit), SEARCH_LIMIT_MAX)),
        market: "from_token",
      },
    );
    return (body.tracks?.items ?? []).filter(
      (t): t is SpotifyTrack => !!t && typeof t.uri === "string",
    );
  }

  async createPlaylist(p: {
    name: string;
    description: string;
    public: boolean;
  }): Promise<CreatedPlaylist> {
    const body = await this.request<{
      id: string;
      uri: string;
      name: string;
      external_urls?: { spotify?: string };
    }>("POST", "/me/playlists", undefined, p);
    return {
      id: body.id,
      uri: body.uri,
      name: body.name,
      url: body.external_urls?.spotify ?? `https://open.spotify.com/playlist/${body.id}`,
    };
  }

  async addItems(playlistId: string, uris: readonly string[]): Promise<void> {
    if (uris.length > ADD_BATCH) throw new Error(`addItems: at most ${ADD_BATCH} URIs per call`);
    await this.request("POST", `/playlists/${encodeURIComponent(playlistId)}/items`, undefined, {
      uris,
    });
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    query?: Record<string, string>,
    json?: unknown,
  ): Promise<T> {
    const now = this.cfg.now ?? Date.now;
    const sleep = this.cfg.sleep ?? sleepMs;
    const url = new URL(`${this.cfg.apiBase ?? API_BASE}${path}`);
    if (query) url.search = new URLSearchParams(query).toString();
    let token = await this.tokens.access();
    let refreshed = false;
    let waits = 0;
    let serverRetries = 0;
    for (;;) {
      const wait = this.pausedUntil - now();
      if (wait > 0) await sleep(wait);
      this.calls++;
      let res: Response;
      try {
        res = await (this.cfg.fetch ?? fetch)(url, {
          method,
          headers: {
            authorization: `Bearer ${token}`,
            ...(json === undefined ? {} : { "content-type": "application/json" }),
          },
          ...(json === undefined ? {} : { body: JSON.stringify(json) }),
          signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 15_000),
        });
      } catch {
        throw new SpotifyError("network", "Couldn't reach Spotify.");
      }
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T;
      }
      if (res.status === 401 && !refreshed) {
        token = await this.tokens.refresh();
        refreshed = true;
        continue;
      }
      const body = (await res.json().catch(() => null)) as unknown;
      const message = errorMessage(body);
      const status = res.status;
      if (status === 401)
        throw new SpotifyError("unauthorized", "Spotify didn't accept the sign-in.", { status });
      if (status === 403)
        throw new SpotifyError(
          "forbidden",
          message || "Spotify refused the request (allowlist or Premium).",
          { status },
        );
      if (status === 429) {
        if (isQuotaExceeded(body))
          throw new SpotifyError("quota_exceeded", "This Spotify app's request quota is used up.", {
            status,
          });
        const after = retryAfterSeconds(res.headers.get("retry-after"));
        if (after > MAX_RETRY_AFTER_S || waits >= 3)
          throw new SpotifyError("rate_limited", "Spotify asked to slow down.", {
            status,
            retryAfter: after,
          });
        waits++;
        this.pausedUntil = Math.max(this.pausedUntil, now() + after * 1000);
        continue;
      }
      if (status >= 500 && serverRetries < 1) {
        serverRetries++;
        await sleep(1000);
        continue;
      }
      throw new SpotifyError("spotify_error", message || `Spotify answered ${status}.`, { status });
    }
  }
}

/** Seconds; Spotify sends whole seconds. Missing or odd values count as 1. */
export function retryAfterSeconds(header: string | null): number {
  const n = Number(header);
  return Number.isFinite(n) && n >= 0 ? Math.ceil(n) : 1;
}

/** `{"error": {"status": 403, "message": "…"}}` → the message. */
function errorMessage(body: unknown): string {
  const err = (body as { error?: unknown } | null)?.error;
  if (typeof err === "string") return err;
  const m = (err as { message?: unknown } | undefined)?.message;
  return typeof m === "string" ? m : "";
}

/** The quota 429 says `"reason": "QUOTA_EXCEEDED"`, at the top level or inside `error`. */
export function isQuotaExceeded(body: unknown): boolean {
  const b = body as { reason?: unknown; error?: { reason?: unknown; message?: unknown } } | null;
  return (
    b?.reason === "QUOTA_EXCEEDED" ||
    b?.error?.reason === "QUOTA_EXCEEDED" ||
    (typeof b?.error?.message === "string" && b.error.message.includes("QUOTA_EXCEEDED"))
  );
}
