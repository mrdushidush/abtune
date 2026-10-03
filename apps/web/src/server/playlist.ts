import type { LoadedCatalog } from "@abtune/catalog/reader";
import { type Dimensions, GROUPS, generate, type TasteVector, validateTaste } from "@abtune/engine";
import {
  MAX_API_LENGTH,
  MAX_PREVIOUS,
  type PlaylistRequest,
  type PlaylistResponse,
  type PlaylistTrackOut,
} from "../api-types.ts";

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);
const isNumberArray = (x: unknown): x is number[] =>
  Array.isArray(x) && x.every((v) => typeof v === "number");

/** Validate a POST /api/playlist body. Unknown fields are dropped, never echoed or logged. */
export function parsePlaylistRequest(body: unknown, dims: Dimensions): Parsed<PlaylistRequest> {
  if (!isObject(body)) return { ok: false, message: "Body must be a JSON object." };
  const { taste, seed, length, engine_version, catalog_version, previous, swap } = body;
  if (typeof seed !== "string" || !/^[0-9a-f]{16}$/.test(seed))
    return { ok: false, message: "seed must be 16 lowercase hex characters." };
  if (!Number.isInteger(length) || (length as number) < 1 || (length as number) > MAX_API_LENGTH)
    return { ok: false, message: `length must be an integer from 1 to ${MAX_API_LENGTH}.` };
  if (typeof engine_version !== "string" || typeof catalog_version !== "string")
    return { ok: false, message: "engine_version and catalog_version are required." };
  if (
    previous !== undefined &&
    !(
      Array.isArray(previous) &&
      previous.length <= MAX_PREVIOUS &&
      previous.every((id) => typeof id === "string" && /^[0-9a-f-]{36}$/.test(id))
    )
  )
    return { ok: false, message: `previous must be at most ${MAX_PREVIOUS} track ids.` };
  if (swap !== undefined && typeof swap !== "boolean")
    return { ok: false, message: "swap must be a boolean." };
  if (!isObject(taste)) return { ok: false, message: "taste must be an object." };
  if (!isNumberArray(taste.target) || !isNumberArray(taste.weight))
    return { ok: false, message: "taste.target and taste.weight must be number arrays." };
  const groups = {} as Record<(typeof GROUPS)[number], number[] | null>;
  for (const g of GROUPS) {
    const v = taste[g];
    if (v !== null && !isNumberArray(v))
      return { ok: false, message: `taste.${g} must be a number array or null.` };
    groups[g] = v;
  }
  const clean: TasteVector = { target: taste.target, weight: taste.weight, ...groups };
  try {
    validateTaste(dims, clean);
  } catch (err) {
    return { ok: false, message: (err as Error).message };
  }
  return {
    ok: true,
    value: {
      taste: clean,
      seed,
      length: length as number,
      engine_version,
      catalog_version,
      ...(previous ? { previous: previous as string[] } : {}),
      ...(swap ? { swap: true } : {}),
    },
  };
}

/** A `previous` id this catalog doesn't have (a stale client or a forged request). */
export class UnknownTrackError extends Error {
  override name = "UnknownTrackError";
}

/** HANDOFF §9 over the loaded catalog, plus display rows for the picked tracks. */
export async function buildPlaylist(
  catalog: LoadedCatalog,
  req: PlaylistRequest,
  engineVersion: string,
): Promise<PlaylistResponse> {
  const previous = (req.previous ?? []).map((id) => catalog.indexOf(id));
  if (previous.some((i) => i < 0)) throw new UnknownTrackError();
  const out = generate(catalog.columns, req.taste, {
    length: req.length,
    seed: req.seed,
    previous,
    newArtistsOnly: req.swap ?? false,
  });
  const meta = await catalog.meta(out.tracks.map((t) => t.index));
  const tracks: PlaylistTrackOut[] = meta.map((m, i) => ({
    track_id: m.track_id,
    title: m.title,
    artist: m.artist_credit,
    album: m.release_title,
    year: m.year,
    isrcs: m.isrcs,
    language: m.language,
    genre: m.primary_cluster,
    decade: out.tracks[i]?.decade ?? null,
    length_ms: m.length_ms,
  }));
  return {
    catalog_version: catalog.columns.version,
    catalog_kind: catalog.manifest.kind,
    engine_version: engineVersion,
    seed: req.seed,
    length: req.length,
    warnings: out.warnings,
    tracks,
  };
}
