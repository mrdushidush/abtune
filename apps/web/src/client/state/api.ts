import {
  applyTweaks,
  type Bank,
  type Dimensions,
  engineVersion,
  MAX_TWEAK_STEPS,
  type SessionState,
  sessionSeed,
  sha256Hex,
  type TasteVector,
  type TweakSteps,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import type { ApiError, Health, PlaylistRequest, PlaylistResponse } from "../../api-types.ts";

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
): PlaylistRequest {
  return firstRequest(
    bank.dimensions,
    tasteVector(bank, viewSession(bank, session).profile),
    tweaks,
    {
      seed: sessionSeed(bank, session, catalogVersion),
      length: session.config.length,
      engine_version: engineVersion(bank),
      catalog_version: catalogVersion,
    },
  );
}

/** The first playlist for a (base) taste and its tweaks: a session's, or a share link's. */
export function firstRequest(
  dims: Dimensions,
  base: TasteVector,
  tweaks: TweakSteps,
  rest: Omit<PlaylistRequest, "taste">,
): PlaylistRequest {
  return { ...rest, taste: applyTweaks(dims, base, tweaks) };
}

/** Songs per "deeper cuts" page. */
export const MORE_LENGTH = 25;

/** A follow-up request's seed: the playlist's seed, what it is for, and a counter. */
export function followUpSeed(seed: string, what: "more" | "swap", n: number): string {
  return sha256Hex(`${seed}:${what}:${n}`).slice(0, 16);
}

/**
 * "+25 deeper cuts" (owner decision D9): the same profile one popularity step deeper, continuing
 * the playlist that's on screen (`shown`, in order) so §9.3 holds over the whole list.
 */
export function moreRequest(
  dims: Dimensions,
  base: TasteVector,
  tweaks: TweakSteps,
  first: PlaylistRequest,
  shown: readonly string[],
  page: number,
): PlaylistRequest {
  const deeper = Math.max(-MAX_TWEAK_STEPS, (tweaks.popularity ?? 0) - 1);
  return {
    ...first,
    taste: applyTweaks(dims, base, { ...tweaks, popularity: deeper }),
    seed: followUpSeed(first.seed, "more", page),
    length: MORE_LENGTH,
    previous: shown,
  };
}

/** Swap one song for another by an artist not on the list yet. */
export function swapRequest(
  first: PlaylistRequest,
  shown: readonly string[],
  n: number,
): PlaylistRequest {
  return {
    ...first,
    seed: followUpSeed(first.seed, "swap", n),
    length: 1,
    previous: shown,
    swap: true,
  };
}

export type ApiResult<T> =
  | { readonly ok: true; readonly data: T }
  | { readonly ok: false; readonly status: number; readonly error: ApiError | null };

async function call<T>(url: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const res = await fetch(url, init);
    const body = (await res.json().catch(() => null)) as unknown;
    return res.ok
      ? { ok: true, data: body as T }
      : { ok: false, status: res.status, error: (body as ApiError) ?? null };
  } catch {
    return { ok: false, status: 0, error: null };
  }
}

export const fetchHealth = () => call<Health>("/api/health");

export const postPlaylist = (req: PlaylistRequest, signal?: AbortSignal) =>
  call<PlaylistResponse>("/api/playlist", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
    signal: signal ?? null,
  });
