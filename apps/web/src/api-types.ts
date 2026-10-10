// The HTTP contract between the client and the server (types only, shared by both sides).
import type { Choice, GenerateWarning, TasteAdjust, TasteVector } from "@abtune/engine";

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

/** The AI layer (HANDOFF §10) as configured on this server. */
export interface AiHealth {
  /** A model is configured (AI_PROVIDER=openai_compat): the setup screen offers AI. */
  readonly enabled: boolean;
  /** T2 rerank runs on first playlists (RERANK_BACKEND=llm). */
  readonly rerank: boolean;
  /** The setup screen may offer sending sensitive answers too (ALLOW_SENSITIVE_TO_AI). */
  readonly sensitive_opt_in: boolean;
  /** The configured model id, or null when off. */
  readonly model: string | null;
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
  readonly ai: AiHealth;
  /** Spotify is set up in `.env` (HANDOFF §11.1): the result screens offer "Save to Spotify". */
  readonly spotify: { readonly configured: boolean };
  /** Where share links point: this server's public URL, or the public instance. Ends with "/". */
  readonly share_url: string;
  /** This server counts usage events (STATS_FILE): the client reports them to POST /api/event. */
  readonly stats: boolean;
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
  /**
   * AI rerank (T2) of a first page: the model chooses from a shortlist of the same taste and seed.
   * Not with `previous` or `picks`.
   */
  readonly rerank?: boolean;
  /** For `rerank`: the AI title and blurb (T1/T3), what this playlist is for. */
  readonly context?: { readonly title?: string; readonly blurb?: string };
  /** A rerank's chosen shortlist positions (a response's `picks`): the same playlist, no AI. */
  readonly picks?: readonly number[];
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
  /** The shortlist positions this list was chosen from (rerank or `picks`): share them. */
  readonly picks?: readonly number[];
  /** Rerank's "why" per track id, for the rows that have one. */
  readonly notes?: Readonly<Record<string, string>>;
  /** Whether a requested rerank happened; on fallback the list is the classic one. */
  readonly rerank?: "done" | AiFailureCode;
}

export type ApiErrorCode =
  | "bad_request"
  /** A POST whose Origin isn't this server. */
  | "cross_site"
  /** A Host this server doesn't answer to (DNS rebinding); APP_BASE_URL names one more. */
  | "unknown_host"
  | "too_large"
  | "not_found"
  | "no_catalog"
  | "catalog_loading"
  | "catalog_error"
  | "version_mismatch"
  /** The AI layer is off on this server. */
  | "ai_off"
  /** The model gave nothing usable; `reason` says why. */
  | "ai_failed"
  /**
   * This visitor asked for playlists faster than PLAYLISTS_PER_MINUTE (or sent events faster than
   * EVENTS_PER_MINUTE); `retry_after` says when.
   */
  | "rate_limited";

/** Why an AI call gave nothing (HANDOFF §10.4): the classic result is used, with a notice. */
export type AiFailureCode = "off" | "timeout" | "unreachable" | "invalid" | "oversized" | "busy";

/** One answer for T1, as the quiz logged it. Sensitive ones only with the opt-in (HANDOFF §13). */
export interface AiAnswer {
  readonly id: string;
  readonly choice: Choice;
}

/** POST /api/ai/interpret (T1): the answers (filtered) and the engine's profile. */
export interface InterpretRequest {
  readonly engine_version: string;
  readonly answers: readonly AiAnswer[];
  readonly taste: TasteVector;
  /** The per-session opt-in; honored only when the server allows it. */
  readonly include_sensitive?: boolean;
}

/** POST /api/ai/tweak (T3): a free-text request for the card taste. */
export interface TextTweakRequest {
  readonly engine_version: string;
  readonly text: string;
  readonly taste: TasteVector;
}

/** Both AI routes answer with a bounded adjustment, a title and a blurb. */
export interface AiAdjustResponse {
  readonly adjust: TasteAdjust;
  readonly title: string | null;
  readonly blurb: string | null;
  /** Interpret: what went to the model. */
  readonly sent?: { readonly answers: number; readonly sensitive: number };
}

/** Longest free-text tweak (`MAX_TWEAK_TEXT` in @abtune/ai; a test keeps them equal). */
export const MAX_AI_TEXT = 200;

/** Most answers an interpret request may carry. */
export const MAX_AI_REQUEST_ANSWERS = 300;

export interface ApiError {
  readonly error: ApiErrorCode;
  readonly message?: string;
  /** On version_mismatch: what the server runs. */
  readonly engine_version?: string;
  readonly catalog_version?: string;
  /** On ai_failed. */
  readonly reason?: AiFailureCode;
  /** On rate_limited: seconds until the next request is allowed (also the Retry-After header). */
  readonly retry_after?: number;
}

/**
 * Source tags a landing link may carry (`?via=x`): the site's own links on X, Instagram and TikTok.
 * Any other value is ignored, so nobody can make up new counter names.
 */
export const VIA_TAGS = ["x", "ig", "tt"] as const;
export type ViaTag = (typeof VIA_TAGS)[number];

/** Usage events a public instance counts (POST /api/event, `{"e": name}`); nothing else is sent. */
export const STAT_EVENTS = [
  "quiz_start",
  "quiz_done",
  "ten_more",
  "shared_open",
  "share_link",
  "share_image",
  "export_m3u",
  "export_csv",
  "export_xspf",
  "export_json",
  "handoff_spotify",
  "handoff_apple_music",
  "handoff_youtube_music",
  // Per source tag: a day this device opened the site with the tag, and quizzes started and
  // finished with it.
  "via_x_open",
  "via_ig_open",
  "via_tt_open",
  "quiz_start_via_x",
  "quiz_start_via_ig",
  "quiz_start_via_tt",
  "quiz_done_via_x",
  "quiz_done_via_ig",
  "quiz_done_via_tt",
] as const;
export type StatEvent = (typeof STAT_EVENTS)[number];

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
