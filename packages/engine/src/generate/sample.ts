import type { Rng } from "../rng.ts";
import type { Cell, CellPlan } from "./cells.ts";
import type { CatalogColumns } from "./columns.ts";
import type { GeneratorParams } from "./params.ts";
import { SCORE_SCALE } from "./score.ts";

/** Integer resolution of sampling weights (the best candidate weighs this much). */
const WEIGHT_RESOLUTION = 1 << 16;

/** What has been picked so far, across cells, with the §9.3 bookkeeping. */
export class Picks {
  readonly tracks: number[] = [];
  readonly scores: number[] = [];
  readonly cells: number[] = [];
  private readonly used = new Set<number>();
  private readonly perArtist = new Map<number, number>();
  private readonly titles = new Set<number>();
  private readonly columns: CatalogColumns;
  private readonly cap: number;

  constructor(columns: CatalogColumns, cap: number) {
    this.columns = columns;
    this.cap = cap;
  }

  /** §9.3: not picked yet, artist under its cap, normalized title not taken. */
  fits(i: number): boolean {
    return (
      !this.used.has(i) &&
      (this.perArtist.get(this.columns.artist[i] as number) ?? 0) < this.cap &&
      !this.titles.has(this.columns.titleKey[i] as number)
    );
  }

  add(i: number, score: number, cell: number): void {
    this.tracks.push(i);
    this.scores.push(score);
    this.cells.push(cell);
    this.used.add(i);
    const a = this.columns.artist[i] as number;
    this.perArtist.set(a, (this.perArtist.get(a) ?? 0) + 1);
    this.titles.add(this.columns.titleKey[i] as number);
  }
}

/**
 * Member offsets of a cell's `k` best tracks: score descending, then track index ascending
 * (members are stored in ascending index order, so offset order is index order).
 */
export function topK(scores: Int32Array, start: number, size: number, k: number): number[] {
  const kk = Math.min(k, size);
  if (kk <= 0) return [];
  // Min-heap on "worse first": lower score, or same score and higher offset.
  const heap = new Int32Array(kk);
  let len = 0;
  const worse = (a: number, b: number) =>
    (scores[a] as number) < (scores[b] as number) ||
    ((scores[a] as number) === (scores[b] as number) && a > b);
  const siftDown = (pos: number) => {
    for (;;) {
      const l = 2 * pos + 1;
      const r = l + 1;
      let m = pos;
      if (l < len && worse(heap[l] as number, heap[m] as number)) m = l;
      if (r < len && worse(heap[r] as number, heap[m] as number)) m = r;
      if (m === pos) return;
      const t = heap[pos] as number;
      heap[pos] = heap[m] as number;
      heap[m] = t;
      pos = m;
    }
  };
  for (let o = start; o < start + size; o++) {
    if (len < kk) {
      let pos = len++;
      heap[pos] = o;
      while (pos > 0) {
        const parent = (pos - 1) >> 1;
        if (!worse(heap[pos] as number, heap[parent] as number)) break;
        const t = heap[pos] as number;
        heap[pos] = heap[parent] as number;
        heap[parent] = t;
        pos = parent;
      }
    } else if (worse(heap[0] as number, o)) {
      heap[0] = o;
      siftDown(0);
    }
  }
  return Array.from(heap.subarray(0, len)).sort((a, b) => (worse(a, b) ? 1 : worse(b, a) ? -1 : 0));
}

/** Track similarity for MMR: 1 for the same artist, else 1 − mean |Δfeature| / 2. */
export function similarity(columns: CatalogColumns, i: number, j: number): number {
  if (columns.artist[i] === columns.artist[j]) return 1;
  let l1 = 0;
  for (const col of columns.scalars) l1 += Math.abs((col[i] as number) - (col[j] as number));
  return 1 - l1 / (2 * columns.scalars.length);
}

export interface PickContext {
  readonly columns: CatalogColumns;
  readonly plan: CellPlan;
  /** Quantized scores aligned with `plan.members`. */
  readonly scores: Int32Array;
  readonly params: GeneratorParams;
  readonly rng: Rng;
  readonly picks: Picks;
}

/**
 * HANDOFF §9.2.3: pick up to `want` tracks from a cell. The pool is its top poolFactor × want
 * tracks; each pick is a seeded draw, softmax over (score − λ·similarity to the closest pick so
 * far) at temperature T, among pool tracks that satisfy §9.3. The pool grows (doubling) only when
 * nothing in it fits. Returns how many were picked; fewer than `want` means the cell is exhausted.
 */
export function pickFromCell(ctx: PickContext, cell: Cell, want: number): number {
  const { columns, plan, scores, params, rng, picks } = ctx;
  if (want <= 0) return 0;
  const sampleSize = Math.max(1, Math.ceil(params.poolFactor * want));
  let k = Math.min(cell.size, sampleSize);
  let pool = topK(scores, cell.start, cell.size, k);
  let maxSim = similarities(ctx, pool);
  let got = 0;
  const cand: number[] = [];
  const weights: number[] = [];
  while (got < want) {
    cand.length = 0;
    for (let p = 0; p < pool.length && cand.length < sampleSize; p++) {
      if (picks.fits(plan.members[pool[p] as number] as number)) cand.push(p);
    }
    if (cand.length === 0) {
      if (k >= cell.size) break;
      k = Math.min(cell.size, k * 2);
      pool = topK(scores, cell.start, cell.size, k);
      maxSim = similarities(ctx, pool);
      continue;
    }
    let maxAdj = Number.NEGATIVE_INFINITY;
    const adj = cand.map((p) => {
      const a =
        (scores[pool[p] as number] as number) / SCORE_SCALE -
        params.mmrLambda * (maxSim[p] as number);
      if (a > maxAdj) maxAdj = a;
      return a;
    });
    weights.length = 0;
    let total = 0;
    for (const a of adj) {
      const w = Math.floor(Math.exp((a - maxAdj) / params.temperature) * WEIGHT_RESOLUTION);
      weights.push(w);
      total += w;
    }
    let r = rng.int(total);
    let chosen = 0;
    while (r >= (weights[chosen] as number)) {
      r -= weights[chosen] as number;
      chosen++;
    }
    const p = cand[chosen] as number;
    const offset = pool[p] as number;
    const track = plan.members[offset] as number;
    picks.add(track, scores[offset] as number, cell.id);
    got++;
    for (let q = 0; q < pool.length; q++) {
      const s = similarity(columns, plan.members[pool[q] as number] as number, track);
      if (s > (maxSim[q] as number)) maxSim[q] = s;
    }
  }
  return got;
}

/** For each pool entry, its highest similarity to any track picked so far (0 if none). */
function similarities(ctx: PickContext, pool: readonly number[]): Float64Array {
  const out = new Float64Array(pool.length);
  for (let q = 0; q < pool.length; q++) {
    const i = ctx.plan.members[pool[q] as number] as number;
    let m = 0;
    for (const j of ctx.picks.tracks) {
      const s = similarity(ctx.columns, i, j);
      if (s > m) m = s;
    }
    out[q] = m;
  }
  return out;
}
