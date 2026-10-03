import { largestRemainder } from "./cells.ts";
import type { CatalogColumns } from "./columns.ts";
import type { PlaylistTrack } from "./generate.ts";
import { artistCap, DEFAULT_GENERATOR_PARAMS, type GeneratorParams } from "./params.ts";
import { Picks } from "./sample.ts";
import { sequence } from "./sequence.ts";

/**
 * AI rerank (HANDOFF §10.2 T2). The generator makes a longer playlist from the same taste and seed
 * (the shortlist); the model only chooses which of its songs to keep. The engine keeps the
 * shortlist's (genre, decade) mix and §9.3, so a hallucinated or empty answer still gives a valid
 * playlist. The chosen positions are what a share link carries: replaying them needs no AI.
 */

/** §10.2: rerank on a shortlist of at most this many songs. */
export const MAX_SHORTLIST = 150;

/** Shortlist length for an `n`-song playlist: three candidates per slot, at most MAX_SHORTLIST. */
export function shortlistLength(n: number): number {
  return Math.max(n, Math.min(MAX_SHORTLIST, 3 * n));
}

/** Shortlist positions, best score first (ties: earlier position). */
function byScore(shortlist: readonly PlaylistTrack[]): number[] {
  return shortlist
    .map((t, p) => ({ p, s: t.score }))
    .sort((a, b) => b.s - a.s || a.p - b.p)
    .map((x) => x.p);
}

const cellKey = (t: PlaylistTrack) => `${t.genre ?? ""}|${t.decade ?? ""}`;

/**
 * The `n` shortlist positions to keep, ascending. `order` is the model's preference (positions,
 * best first; invalid and repeated entries are ignored). Each (genre, decade) cell keeps its share
 * of the shortlist; within a cell the model's order wins, then the score fills the gaps.
 */
export function chooseFromShortlist(
  columns: CatalogColumns,
  shortlist: readonly PlaylistTrack[],
  order: readonly number[],
  n: number,
  params: GeneratorParams = DEFAULT_GENERATOR_PARAMS,
): number[] {
  const want = Math.min(n, shortlist.length);
  const cells = new Map<string, number>();
  const cellOf = shortlist.map((t) => {
    const key = cellKey(t);
    if (!cells.has(key)) cells.set(key, cells.size);
    return cells.get(key) as number;
  });
  const counts = new Array<number>(cells.size).fill(0);
  for (const c of cellOf) counts[c] = (counts[c] as number) + 1;
  const quota = largestRemainder(counts, want);
  const taken = new Array<number>(cells.size).fill(0);
  const picks = new Picks(columns, artistCap(n, params));
  const chosen = new Set<number>();
  const take = (p: number, quotas: boolean): void => {
    if (chosen.size >= want || chosen.has(p)) return;
    const t = shortlist[p];
    const c = cellOf[p];
    if (t === undefined || c === undefined) return;
    if (quotas && (taken[c] as number) >= (quota[c] as number)) return;
    if (!picks.fits(t.index)) return;
    picks.add(t.index, 0, 0);
    chosen.add(p);
    taken[c] = (taken[c] as number) + 1;
  };
  for (const p of order) if (Number.isInteger(p)) take(p, true);
  const ranked = byScore(shortlist);
  for (const p of ranked) take(p, true);
  for (const p of ranked) take(p, false);
  return [...chosen].sort((a, b) => a - b);
}

/**
 * The playlist for chosen shortlist positions, in play order (§9.4). Checks §9.3 again (positions
 * from a share link are untrusted) and tops up from the score order if any were dropped, so it
 * returns min(n, shortlist length) positions. For a valid choice the result depends only on the set.
 */
export function playShortlist(
  columns: CatalogColumns,
  shortlist: readonly PlaylistTrack[],
  chosen: readonly number[],
  n: number,
  params: GeneratorParams = DEFAULT_GENERATOR_PARAMS,
): number[] {
  const want = Math.min(n, shortlist.length);
  const picks = new Picks(columns, artistCap(n, params));
  const kept = new Set<number>();
  const take = (p: number) => {
    if (kept.size >= want || kept.has(p)) return;
    const t = shortlist[p];
    if (t === undefined || !picks.fits(t.index)) return;
    picks.add(t.index, 0, 0);
    kept.add(p);
  };
  for (const p of [...chosen].filter(Number.isInteger).sort((a, b) => a - b)) take(p);
  for (const p of byScore(shortlist)) take(p);
  const positions = [...kept].sort((a, b) => a - b);
  const tracks = positions.map((p) => (shortlist[p] as PlaylistTrack).index);
  return sequence(columns, tracks, params.tempoLambda).map((i) => positions[i] as number);
}
