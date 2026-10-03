// Share links (HANDOFF §4.4, M6) and the playlist edits they replay ("+25 deeper cuts", swaps).
// The live result screen and a share replay build their requests here, so they can't drift apart.
import {
  type Dimensions,
  decodeShare,
  encodeShare,
  type ShareData,
  type ShareOp,
  type TasteVector,
  type TweakSteps,
} from "@abtune/engine";
import type { PlaylistRequest, PlaylistResponse, PlaylistTrackOut } from "../../api-types.ts";
import { type ApiResult, firstRequest, moreRequest, swapRequest } from "./api.ts";

/** Edits on top of a first playlist, in order. Follow-up seeds count pages and swaps separately. */
export interface Edits {
  readonly ops: readonly ShareOp[];
}

export const NO_EDITS: Edits = { ops: [] };

const count = (ops: readonly ShareOp[], kind: ShareOp["op"]) =>
  ops.filter((o) => o.op === kind).length;

/** The request for one more edit, given the tracks on screen before it. */
export function editRequest(
  dims: Dimensions,
  base: TasteVector,
  tweaks: TweakSteps,
  first: PlaylistRequest,
  shown: readonly PlaylistTrackOut[],
  done: readonly ShareOp[],
  op: ShareOp,
): PlaylistRequest {
  const ids = shown.map((x) => x.track_id);
  return op.op === "more"
    ? moreRequest(dims, base, tweaks, first, ids, count(done, "more") + 1)
    : swapRequest(first, ids, count(done, "swap") + 1);
}

/** The list after an edit's tracks arrive. */
export function applyEdit(
  shown: readonly PlaylistTrackOut[],
  op: ShareOp,
  got: readonly PlaylistTrackOut[],
): PlaylistTrackOut[] {
  if (op.op === "more") return [...shown, ...got];
  return shown.map((x, k) => (k === op.index && got[0] ? got[0] : x));
}

export type Post = (req: PlaylistRequest) => Promise<ApiResult<PlaylistResponse>>;

export type Replay =
  | {
      readonly ok: true;
      readonly first: PlaylistRequest;
      readonly response: PlaylistResponse;
      readonly tracks: readonly PlaylistTrackOut[];
      /** Edits that came back empty or failed (the list stops short of the original). */
      readonly skipped: number;
    }
  | { readonly ok: false; readonly result: ApiResult<PlaylistResponse> };

/**
 * Rebuild a shared playlist: the first request, then each edit in order, exactly as the result
 * screen made them. `versions` are what this server runs; when they differ from the link's, the
 * same taste and seed go to the current engine and catalog (the songs may differ).
 */
export async function replayShare(
  dims: Dimensions,
  data: ShareData,
  versions: { readonly engine_version: string; readonly catalog_version: string },
  post: Post,
): Promise<Replay> {
  const first = firstRequest(dims, data.taste, data.tweaks, {
    seed: data.seed,
    length: data.length,
    ...versions,
  });
  const r = await post(first);
  if (!r.ok) return { ok: false, result: r };
  let tracks: PlaylistTrackOut[] = [...r.data.tracks];
  let skipped = 0;
  const done: ShareOp[] = [];
  for (const op of data.ops) {
    if (op.op === "swap" && op.index >= tracks.length) {
      skipped++;
      continue;
    }
    const e = await post(editRequest(dims, data.taste, data.tweaks, first, tracks, done, op));
    if (!e.ok || e.data.tracks.length === 0) {
      skipped++;
      continue;
    }
    tracks = applyEdit(tracks, op, e.data.tracks);
    done.push(op);
  }
  return { ok: true, first, response: r.data, tracks, skipped };
}

/** The hash a share link carries: `#s=<code>`. The fragment never reaches the server. */
export const SHARE_HASH = "#s=";

export function shareUrl(base: string, code: string): string {
  return `${base.replace(/#.*$/, "")}${SHARE_HASH}${code}`;
}

/** The share code in a location hash, or null. */
export function shareCodeOf(hash: string): string | null {
  return hash.startsWith(SHARE_HASH) && hash.length > SHARE_HASH.length
    ? hash.slice(SHARE_HASH.length)
    : null;
}

export { decodeShare, encodeShare };
