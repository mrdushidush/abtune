import { type AiRuntime, cleanText, rerankTask, runTask } from "@abtune/ai";
import type { LoadedCatalog } from "@abtune/catalog/reader";
import {
  chooseFromShortlist,
  clusterLabel,
  type Dimensions,
  type GenerateWarning,
  GROUPS,
  generate,
  MAX_BLURB_CHARS,
  MAX_SHORTLIST,
  MAX_TITLE_CHARS,
  type PlaylistTrack,
  playShortlist,
  shortlistLength,
  type TasteVector,
  validateTaste,
} from "@abtune/engine";
import {
  type AiFailureCode,
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

/** Ascending, distinct shortlist positions: at least one, at most `max`. */
const isPicks = (x: unknown, max: number): x is number[] =>
  Array.isArray(x) &&
  x.length > 0 &&
  x.length <= max &&
  x.every(
    (p, i) =>
      Number.isInteger(p) && p >= 0 && p < MAX_SHORTLIST && (i === 0 || p > (x[i - 1] as number)),
  );

/** A taste vector from JSON: only the known fields, checked against the bank's dimensions. */
export function parseTaste(taste: unknown, dims: Dimensions): Parsed<TasteVector> {
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
  return { ok: true, value: clean };
}

/** Validate a POST /api/playlist body. Unknown fields are dropped, never echoed or logged. */
export function parsePlaylistRequest(body: unknown, dims: Dimensions): Parsed<PlaylistRequest> {
  if (!isObject(body)) return { ok: false, message: "Body must be a JSON object." };
  const { taste, seed, length, engine_version, catalog_version, previous, swap, rerank, picks } =
    body;
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
  if (rerank !== undefined && typeof rerank !== "boolean")
    return { ok: false, message: "rerank must be a boolean." };
  if (picks !== undefined && !isPicks(picks, Math.min(length as number, MAX_SHORTLIST)))
    return { ok: false, message: "picks must be ascending shortlist positions." };
  if ((rerank || picks) && (previous !== undefined || swap || (rerank && picks)))
    return { ok: false, message: "rerank and picks are for a first page, one at a time." };
  const context = parseContext(body.context);
  if (context === false) return { ok: false, message: "context must be a short title and blurb." };
  const clean = parseTaste(taste, dims);
  if (!clean.ok) return clean;
  return {
    ok: true,
    value: {
      taste: clean.value,
      seed,
      length: length as number,
      engine_version,
      catalog_version,
      ...(previous ? { previous: previous as string[] } : {}),
      ...(swap ? { swap: true } : {}),
      ...(rerank ? { rerank: true } : {}),
      ...(rerank && context ? { context } : {}),
      ...(picks ? { picks: picks as number[] } : {}),
    },
  };
}

/** `context` (rerank's title and blurb), cleaned; undefined when absent, false when malformed. */
function parseContext(x: unknown): { title?: string; blurb?: string } | undefined | false {
  if (x === undefined) return undefined;
  if (!isObject(x)) return false;
  const out: { title?: string; blurb?: string } = {};
  for (const [key, max] of [
    ["title", MAX_TITLE_CHARS],
    ["blurb", MAX_BLURB_CHARS],
  ] as const) {
    const v = x[key];
    if (v === undefined) continue;
    if (typeof v !== "string" || v.length > 4 * max) return false;
    const clean = cleanText(v, max);
    if (clean) out[key] = clean;
  }
  return out;
}

/** A `previous` id this catalog doesn't have (a stale client or a forged request). */
export class UnknownTrackError extends Error {
  override name = "UnknownTrackError";
}

/** The AI layer as /api/playlist sees it: rerank needs a runtime and RERANK_BACKEND=llm. */
export interface PlaylistAi {
  readonly runtime: AiRuntime | null;
  readonly rerank: boolean;
}

const NO_AI: PlaylistAi = { runtime: null, rerank: false };

interface Picked {
  readonly tracks: readonly PlaylistTrack[];
  readonly warnings: readonly GenerateWarning[];
  /** "Why" per position in `tracks`. */
  readonly notes: Readonly<Record<number, string>>;
  readonly extra: Pick<PlaylistResponse, "picks" | "rerank">;
}

/**
 * A first page chosen from a shortlist of the same taste and seed (HANDOFF §10.2 T2): by the model
 * (rerank), or replayed from `picks` without it. A failed rerank is the classic list.
 */
async function fromShortlist(
  catalog: LoadedCatalog,
  req: PlaylistRequest,
  rerank: AiRuntime | null,
): Promise<Picked> {
  const columns = catalog.columns;
  const short = generate(columns, req.taste, {
    length: shortlistLength(req.length),
    seed: req.seed,
  });
  let chosen: readonly number[] | null = req.picks ?? null;
  let notes: Readonly<Record<number, string>> = {};
  let failure: AiFailureCode = "off";
  if (rerank) {
    const meta = await catalog.meta(short.tracks.map((t) => t.index));
    const r = await runTask(rerank, rerankTask(), {
      dims: columns.dimensions,
      taste: req.taste,
      n: Math.min(req.length, short.tracks.length),
      title: req.context?.title ?? null,
      blurb: req.context?.blurb ?? null,
      songs: meta.map((m) => ({
        title: m.title,
        artist: m.artist_credit,
        year: m.year,
        genre: m.primary_cluster ? clusterLabel(m.primary_cluster) : null,
      })),
    });
    if (r.ok) {
      chosen = chooseFromShortlist(columns, short.tracks, r.value.order, req.length);
      notes = r.value.notes;
    } else failure = r.failure;
  }
  if (!chosen) {
    const out = generate(columns, req.taste, { length: req.length, seed: req.seed });
    return { tracks: out.tracks, warnings: out.warnings, notes: {}, extra: { rerank: failure } };
  }
  const play = playShortlist(columns, short.tracks, chosen, req.length);
  const warnings =
    play.length < req.length && !short.warnings.includes("catalog_exhausted")
      ? [...short.warnings, "catalog_exhausted" as const]
      : short.warnings;
  return {
    tracks: play.map((p) => short.tracks[p] as PlaylistTrack),
    warnings,
    // Notes follow their shortlist position into the played order.
    notes: Object.fromEntries(play.flatMap((p, i) => (notes[p] ? [[i, notes[p]]] : []))),
    extra: { picks: [...play].sort((a, b) => a - b), ...(rerank ? { rerank: "done" } : {}) },
  };
}

/** HANDOFF §9 over the loaded catalog, plus display rows for the picked tracks. */
export async function buildPlaylist(
  catalog: LoadedCatalog,
  req: PlaylistRequest,
  engineVersion: string,
  ai: PlaylistAi = NO_AI,
): Promise<PlaylistResponse> {
  const previous = (req.previous ?? []).map((id) => catalog.indexOf(id));
  if (previous.some((i) => i < 0)) throw new UnknownTrackError();
  const rerank = req.rerank && ai.rerank ? ai.runtime : null;
  let picked: Picked;
  if (req.picks || rerank) picked = await fromShortlist(catalog, req, rerank);
  else {
    const out = generate(catalog.columns, req.taste, {
      length: req.length,
      seed: req.seed,
      previous,
      newArtistsOnly: req.swap ?? false,
    });
    picked = {
      tracks: out.tracks,
      warnings: out.warnings,
      notes: {},
      extra: req.rerank ? { rerank: "off" } : {},
    };
  }
  const meta = await catalog.meta(picked.tracks.map((t) => t.index));
  const tracks: PlaylistTrackOut[] = meta.map((m, i) => ({
    track_id: m.track_id,
    title: m.title,
    artist: m.artist_credit,
    album: m.release_title,
    year: m.year,
    isrcs: m.isrcs,
    language: m.language,
    genre: m.primary_cluster,
    decade: picked.tracks[i]?.decade ?? null,
    length_ms: m.length_ms,
  }));
  const notes = Object.fromEntries(
    tracks.flatMap((t, i) => (picked.notes[i] ? [[t.track_id, picked.notes[i]]] : [])),
  );
  return {
    catalog_version: catalog.columns.version,
    catalog_kind: catalog.manifest.kind,
    engine_version: engineVersion,
    seed: req.seed,
    length: req.length,
    warnings: picked.warnings,
    tracks,
    ...picked.extra,
    ...(Object.keys(notes).length > 0 ? { notes } : {}),
  };
}
