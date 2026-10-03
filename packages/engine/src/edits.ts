import { sha256Hex } from "./hash.ts";
import type { ShareOp } from "./share.ts";
import type { TasteVector } from "./taste.ts";
import { applyTweaks, MAX_TWEAK_STEPS, type TweakSteps } from "./tweak.ts";
import type { Dimensions } from "./types.ts";

/**
 * Edits on a playlist after it's made (owner decision D9): "+25 deeper cuts" and swapping one song.
 * The web app (over HTTP), share links and the MCP server (in process) all plan them here, so the
 * same edits give the same songs everywhere.
 */

/** Songs per "deeper cuts" page. */
export const MORE_LENGTH = 25;

/** A follow-up's seed: the playlist's seed, what it is for, and a counter. */
export function followUpSeed(seed: string, what: "more" | "swap" | "backfill", n: number): string {
  return sha256Hex(`${seed}:${what}:${n}`).slice(0, 16);
}

/** Generator inputs for one step. The caller adds the tracks already shown as `previous`. */
export interface PlaylistStep {
  readonly taste: TasteVector;
  readonly seed: string;
  readonly length: number;
  /** Only artists not in `previous` (a swap). */
  readonly swap: boolean;
}

/** The first playlist: the profile with its tweaks applied. */
export function firstStep(
  dims: Dimensions,
  base: TasteVector,
  tweaks: TweakSteps,
  seed: string,
  length: number,
): PlaylistStep {
  return { taste: applyTweaks(dims, base, tweaks), seed, length, swap: false };
}

/**
 * The next edit after `done` (the edits already applied, which number the follow-up seeds).
 * "+25 deeper cuts" is the same profile one popularity step deeper; a swap is one song by an
 * artist not on the list yet, from the first playlist's taste.
 */
export function editStep(
  dims: Dimensions,
  base: TasteVector,
  tweaks: TweakSteps,
  first: PlaylistStep,
  done: readonly ShareOp[],
  op: ShareOp,
): PlaylistStep {
  const n = done.filter((o) => o.op === op.op).length + 1;
  if (op.op === "swap")
    return { taste: first.taste, seed: followUpSeed(first.seed, "swap", n), length: 1, swap: true };
  const deeper = Math.max(-MAX_TWEAK_STEPS, (tweaks.popularity ?? 0) - 1);
  return {
    taste: applyTweaks(dims, base, { ...tweaks, popularity: deeper }),
    seed: followUpSeed(first.seed, "more", n),
    length: MORE_LENGTH,
    swap: false,
  };
}

/**
 * The `n`th replacement for a song a destination doesn't have (Spotify backfill, HANDOFF §11.1):
 * like a swap, one song by an artist not on the list yet, from the first playlist's taste. The
 * caller also passes `sameCellAs` (the missing song) to the generator.
 */
export function backfillStep(first: PlaylistStep, n: number): PlaylistStep {
  return {
    taste: first.taste,
    seed: followUpSeed(first.seed, "backfill", n),
    length: 1,
    swap: true,
  };
}

/** The list after an edit's tracks arrive: a page is appended, a swap replaces its position. */
export function applyEdit<T>(shown: readonly T[], op: ShareOp, got: readonly T[]): T[] {
  if (op.op === "more") return [...shown, ...got];
  return shown.map((x, k) => (k === op.index && got[0] !== undefined ? got[0] : x));
}
