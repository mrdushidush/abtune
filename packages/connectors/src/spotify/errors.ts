import type { CreatedPlaylist } from "./client.ts";

/**
 * What can go wrong talking to Spotify (HANDOFF §11.1). Every surface (web app, MCP server) maps a
 * kind to its own message; none of them carries a token.
 */
export type SpotifyErrorKind =
  /** No Client ID or token key configured on this server. */
  | "not_configured"
  /** No stored connection, or Spotify revoked it (the user removed the app's access). */
  | "not_connected"
  /** Still 401 after a token refresh. */
  | "unauthorized"
  /** 403: the user isn't on the app's allowlist, or the app owner's Premium lapsed. */
  | "forbidden"
  /** 429 whose Retry-After is longer than we wait. */
  | "rate_limited"
  /** 429 with reason QUOTA_EXCEEDED: the developer account's quota is used up. */
  | "quota_exceeded"
  /** Not one song of the playlist is on Spotify (nothing was created). */
  | "no_matches"
  /** Spotify unreachable or timed out. */
  | "network"
  /** 5xx, or a response we don't understand. */
  | "spotify_error";

export class SpotifyError extends Error {
  override name = "SpotifyError";
  readonly kind: SpotifyErrorKind;
  readonly status: number | null;
  /** Seconds, on rate_limited. */
  readonly retryAfter: number | null;
  /** Set when the playlist was created but filling it failed part way. */
  readonly partial: CreatedPlaylist | null;
  constructor(
    kind: SpotifyErrorKind,
    message: string,
    opts: {
      status?: number | null;
      retryAfter?: number | null;
      partial?: CreatedPlaylist | null;
    } = {},
  ) {
    super(message);
    this.kind = kind;
    this.status = opts.status ?? null;
    this.retryAfter = opts.retryAfter ?? null;
    this.partial = opts.partial ?? null;
  }
}

export const isSpotifyError = (err: unknown, kind?: SpotifyErrorKind): err is SpotifyError =>
  err instanceof SpotifyError && (kind === undefined || err.kind === kind);
