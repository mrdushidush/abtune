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
