// The HTTP contract between the client and the server (types only, shared by both sides).
import type { GenerateWarning, TasteVector } from "@abtune/engine";

export interface CatalogLicense {
  readonly id: string;
  readonly url: string;
  readonly attribution: string;
}

export type CatalogStatus = "loading" | "ready" | "error";

export interface CatalogHealth {
  readonly version: string;
  readonly kind: string;
  readonly tracks: number;
  readonly status: CatalogStatus;
  readonly license: CatalogLicense | null;
}

/** GET /api/health */
export interface Health {
  readonly name: "ABTune";
  readonly version: string;
  /** Engine semver + bank hash: the client's must match for its seeds to mean the same thing. */
  readonly engine_version: string;
  readonly questions: number;
  readonly packs: Readonly<Record<string, number>>;
  /** The installed catalog, or null when none is installed. */
  readonly catalog: CatalogHealth | null;
}

/**
 * POST /api/playlist. Only the quantized profile travels: never the answers (HANDOFF §13), so
 * sensitive answers can't reach the server. This is also what a share link carries (M6).
 */
export interface PlaylistRequest {
  readonly taste: TasteVector;
  /** 16 hex chars from `sessionSeed`. */
  readonly seed: string;
  readonly length: number;
  readonly engine_version: string;
  readonly catalog_version: string;
  /**
   * Track ids already shown, in order, when this request continues a playlist ("+25 deeper cuts")
   * or swaps one track: they are never picked again and §9.3 holds over the whole list.
   */
  readonly previous?: readonly string[];
  /** Swap: the new track's artist must not be in `previous`. */
  readonly swap?: boolean;
}

/** Most track ids a request may carry in `previous`. */
export const MAX_PREVIOUS = 300;

export interface PlaylistTrackOut {
  /** MusicBrainz recording MBID. */
  readonly track_id: string;
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly year: number | null;
  readonly isrcs: readonly string[];
  readonly language: string;
  readonly genre: string | null;
  readonly decade: string | null;
  readonly length_ms: number | null;
}

export interface PlaylistResponse {
  readonly catalog_version: string;
  readonly catalog_kind: string;
  readonly engine_version: string;
  readonly seed: string;
  readonly length: number;
  readonly warnings: readonly GenerateWarning[];
  readonly tracks: readonly PlaylistTrackOut[];
}

export type ApiErrorCode =
  | "bad_request"
  /** A POST whose Origin isn't this server. */
  | "cross_site"
  | "too_large"
  | "not_found"
  | "no_catalog"
  | "catalog_loading"
  | "catalog_error"
  | "version_mismatch";

export interface ApiError {
  readonly error: ApiErrorCode;
  readonly message?: string;
  /** On version_mismatch: what the server runs. */
  readonly engine_version?: string;
  readonly catalog_version?: string;
}

/** Longest playlist the API generates (the UI offers 25 / 50 / 100). */
export const MAX_API_LENGTH = 100;

/** A `.env` setting Spotify needs that is missing or invalid. */
export type SpotifySetting = "SPOTIFY_CLIENT_ID" | "TOKEN_ENCRYPTION_KEY" | "SPOTIFY_REDIRECT_URI";

/** GET /api/spotify: setup and connection state for this browser. */
export interface SpotifyStatus {
  readonly configured: boolean;
  readonly missing: readonly SpotifySetting[];
  /** Exactly what to register in the Spotify dashboard. */
  readonly redirect_uri: string;
  /** Where the app must be open to sign in (the redirect URI's origin: cookies are per host). */
  readonly app_origin: string;
  readonly connected: { readonly user_id: string; readonly display_name: string | null } | null;
}

/**
 * POST /api/spotify/push. Track ids and the first playlist's request (taste + seed, for
 * replacements): never answers, like every other request (HANDOFF §13).
 */
export interface SpotifyPushRequest {
  readonly name: string;
  readonly description: string;
  /** Default false: a private playlist. */
  readonly public?: boolean;
  /** The playlist on screen, in order. */
  readonly tracks: readonly string[];
  readonly request: PlaylistRequest;
}

export interface SpotifyPushSong {
  readonly track_id: string;
  readonly title: string;
  readonly artist: string;
}

export interface SpotifyPushResponse {
  readonly playlist_url: string;
  readonly name: string;
  readonly requested: number;
  readonly added: number;
  /** Found on the first pass (by ISRC or by title and artist). */
  readonly matched: number;
  readonly by_isrc: number;
  readonly with_isrc: number;
  readonly with_isrc_matched: number;
  /** Songs Spotify doesn't have, and what took their place. */
  readonly replaced: readonly {
    readonly position: number;
    readonly missing: SpotifyPushSong;
    readonly replacement: SpotifyPushSong;
  }[];
  /** Songs nothing could replace (the playlist is that much shorter). */
  readonly missing: readonly SpotifyPushSong[];
}

export type SpotifyErrorCode =
  | "not_configured"
  | "not_connected"
  | "unauthorized"
  | "forbidden"
  | "rate_limited"
  | "quota_exceeded"
  | "no_matches"
  | "network"
  | "spotify_error"
  /** A push from this browser is still running. */
  | "busy";

export interface SpotifyApiError {
  readonly error: SpotifyErrorCode | ApiErrorCode;
  readonly message?: string;
  /** Seconds, on rate_limited. */
  readonly retry_after?: number;
  /** When the playlist was created but filling it failed part way. */
  readonly playlist_url?: string;
  readonly engine_version?: string;
  readonly catalog_version?: string;
}

/** `?spotify=` on the page the sign-in returns to. */
export type SpotifyOutcome =
  | "connected"
  | "denied"
  | "not_allowed"
  | "not_configured"
  | "expired"
  | "error";
