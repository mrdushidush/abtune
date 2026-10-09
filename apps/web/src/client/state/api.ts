import {
  type Bank,
  type Dimensions,
  engineVersion,
  firstStep,
  MORE_LENGTH,
  type PlaylistStep,
  type SessionState,
  sessionSeed,
  type TasteVector,
  type TweakSteps,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import type { ApiError, Health, PlaylistRequest, PlaylistResponse } from "../../api-types.ts";

/** The AI layer's part of a first request (HANDOFF §10): see `aiView`. */
export interface AiRequestParts {
  /** The playlist base: the profile with the AI adjustments (default: the engine profile). */
  readonly base?: TasteVector;
  /** Ask for T2 rerank, with the AI title and blurb as context. */
  readonly rerank?: boolean;
  readonly context?: { readonly title?: string; readonly blurb?: string };
}

/**
 * The POST /api/playlist body for a finished session. Only the quantized (and tweaked) profile, the
 * seed and versions go to the server: never the answer log, so sensitive answers stay on the
 * device (HANDOFF §13).
 */
export function buildPlaylistRequest(
  bank: Bank,
  session: SessionState,
  tweaks: TweakSteps,
  catalogVersion: string,
  ai: AiRequestParts = {},
): PlaylistRequest {
  const req = firstRequest(
    bank.dimensions,
    ai.base ?? tasteVector(bank, viewSession(bank, session).profile),
    tweaks,
    {
      seed: sessionSeed(bank, session, catalogVersion),
      length: session.config.length,
      engine_version: engineVersion(bank),
      catalog_version: catalogVersion,
    },
  );
  if (!ai.rerank) return req;
  const context = ai.context && (ai.context.title || ai.context.blurb) ? ai.context : null;
  return { ...req, rerank: true, ...(context ? { context } : {}) };
}

/** The first playlist for a (base) taste and its tweaks: a session's, or a share link's. */
export function firstRequest(
  dims: Dimensions,
  base: TasteVector,
  tweaks: TweakSteps,
  rest: Omit<PlaylistRequest, "taste">,
): PlaylistRequest {
  return { ...rest, taste: firstStep(dims, base, tweaks, rest.seed, rest.length).taste };
}

/** The request for a planned step (engine `edits.ts`), continuing `shown` track ids in order. */
export function stepRequest(
  step: PlaylistStep,
  versions: Pick<PlaylistRequest, "engine_version" | "catalog_version">,
  shown: readonly string[],
): PlaylistRequest {
  return {
    taste: step.taste,
    seed: step.seed,
    length: step.length,
    engine_version: versions.engine_version,
    catalog_version: versions.catalog_version,
    previous: shown,
    ...(step.swap ? { swap: true } : {}),
  };
}

export { MORE_LENGTH };

export type ApiResult<T, E = ApiError> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: E | null };

/** Status 0 = the server couldn't be reached. */
export async function call<T, E = ApiError>(
  url: string,
  init?: RequestInit,
): Promise<ApiResult<T, E>> {
  try {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => null)) as unknown;
    return res.ok
      ? { ok: true, data: body as T }
      : { ok: false, status: res.status, error: (body as E) ?? null };
  } catch {
    return { ok: false, status: 0, error: null };
  }
}

export const fetchHealth = () => call<Health>("/api/health");

/** How long to wait after a 429 `rate_limited`: its `retry_after`, kept between 1 s and a minute. */
export const retryAfterMs = (error: ApiError | null) =>
  Math.min(60, Math.max(1, error?.retry_after ?? 3)) * 1000;

export const postPlaylist = (req: PlaylistRequest, signal?: AbortSignal) =>
  call<PlaylistResponse>("/api/playlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: signal ?? null,
  });
