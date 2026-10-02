import { createRng } from "../rng.ts";
import { type TasteVector, validateTaste } from "../taste.ts";
import { type Cell, eligibility, largestRemainder, planCells } from "./cells.ts";
import { type CatalogColumns, NONE } from "./columns.ts";
import { artistCap, DEFAULT_GENERATOR_PARAMS, type GeneratorParams } from "./params.ts";
import { type PickContext, Picks, pickFromCell } from "./sample.ts";
import { createScorer, SCORE_SCALE, scoreMany } from "./score.ts";
import { sequence } from "./sequence.ts";

/** Longest playlist `generate` accepts (sampling weights must stay within 32-bit draws). */
export const MAX_LENGTH = 1000;

export type GenerateWarning =
  /** The §9.2 prefilter couldn't fill the playlist; other clusters/decades were used. */
  | "prefilter_relaxed"
  /** The language hard filter couldn't fill it; other languages were used. */
  | "language_relaxed"
  /** Even the whole catalog couldn't fill it under §9.3; the playlist is short. */
  | "catalog_exhausted";

export interface PlaylistTrack {
  /** Row index in the catalog columns. */
  readonly index: number;
  /** §9.1 score in [0, 1], quantized. */
  readonly score: number;
  /** Cell the track was picked from. */
  readonly genre: string | null;
  readonly decade: string | null;
}

export interface CellSummary {
  readonly genre: string | null;
  readonly decade: string | null;
  readonly weight: number;
  /** Slots from the first allocation round. */
  readonly slots: number;
  readonly picked: number;
}

export interface GeneratedPlaylist {
  /** In play order (§9.4). */
  readonly tracks: readonly PlaylistTrack[];
  /** The kept cells of the strict plan, heaviest first. */
  readonly cells: readonly CellSummary[];
  readonly warnings: readonly GenerateWarning[];
}

export interface GenerateOptions {
  readonly length: number;
  /** 16 hex chars (sessionSeed / computeSeed). */
  readonly seed: string;
  readonly params?: GeneratorParams;
}

/**
 * HANDOFF §9: taste vector + catalog → ordered playlist. A pure function of its inputs: the same
 * taste, length, seed, params and catalog give the same ordered list on every run and machine.
 */
export function generate(
  columns: CatalogColumns,
  taste: TasteVector,
  { length, seed, params = DEFAULT_GENERATOR_PARAMS }: GenerateOptions,
): GeneratedPlaylist {
  if (!Number.isInteger(length) || length < 1 || length > MAX_LENGTH) {
    throw new Error(`generate: length must be 1–${MAX_LENGTH}, got ${length}`);
  }
  validateTaste(columns.dimensions, taste);
  const rng = createRng(seed);
  const scorer = createScorer(columns, taste, params);
  const picks = new Picks(columns, artistCap(length, params));
  const warnings: GenerateWarning[] = [];
  let summary: CellSummary[] = [];

  let previous = "";
  for (const relax of [0, 1, 2] as const) {
    if (picks.tracks.length >= length) break;
    const elig = eligibility(columns, taste, params, relax);
    const key = `${elig.genres.join("")}|${elig.decades.join("")}|${elig.language}`;
    if (key === previous) continue; // nothing to relax at this level
    if (relax > 0) warnings.push(relax === 1 ? "prefilter_relaxed" : "language_relaxed");
    previous = key;
    const plan = planCells(columns, taste, params, elig);
    const scores = new Int32Array(plan.members.length);
    scoreMany(scorer, plan.members, scores);
    const ctx: PickContext = { columns, plan, scores, params, rng, picks };
    const before = picks.tracks.length;
    const firstSlots = fillCells(
      ctx,
      plan.cells.filter((c) => c.kept),
      length,
    );
    fillCells(
      ctx,
      plan.cells.filter((c) => !c.kept),
      length,
    );
    if (relax === 0) {
      summary = plan.cells
        .filter((c) => c.kept)
        .map((c) => ({
          genre: c.genre === NONE ? null : (columns.dimensions.genres[c.genre] ?? null),
          decade: c.decade === NONE ? null : (columns.dimensions.decades[c.decade] ?? null),
          weight: c.weight,
          slots: firstSlots.get(c.id) ?? 0,
          picked: picks.cells.slice(before).filter((id) => id === c.id).length,
        }));
    }
  }
  if (picks.tracks.length < length) warnings.push("catalog_exhausted");

  const order = sequence(columns, picks.tracks, params.tempoLambda);
  const D = columns.dimensions.decades.length;
  const tracks = order.map((p) => {
    const cell = picks.cells[p] as number;
    const g = Math.floor(cell / (D + 1));
    const d = cell % (D + 1);
    return {
      index: picks.tracks[p] as number,
      score: (picks.scores[p] as number) / SCORE_SCALE,
      genre: columns.dimensions.genres[g] ?? null,
      decade: columns.dimensions.decades[d] ?? null,
    };
  });
  return { tracks, cells: summary, warnings };
}

/**
 * Fill up to `length` total picks from `cells`: allocate the remaining slots by weight (largest
 * remainder) over cells that still have tracks, pick, close cells that came up short, repeat.
 * Returns the first round's allocation per cell id.
 */
function fillCells(ctx: PickContext, cells: readonly Cell[], length: number): Map<number, number> {
  const first = new Map<number, number>();
  let open = [...cells];
  let round = 0;
  while (open.length > 0 && ctx.picks.tracks.length < length) {
    const want = length - ctx.picks.tracks.length;
    const slots = largestRemainder(
      open.map((c) => c.weight),
      want,
    );
    const stillOpen: Cell[] = [];
    open.forEach((cell, j) => {
      const s = slots[j] as number;
      if (round === 0) first.set(cell.id, s);
      const got = s > 0 ? pickFromCell(ctx, cell, s) : 0;
      if (got >= s) stillOpen.push(cell);
    });
    open = stillOpen;
    round++;
  }
  return first;
}
