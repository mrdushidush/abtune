import type { CatalogColumns } from "./columns.ts";

/**
 * Target energy at relative position x ∈ [0, 1], as a quantile of the playlist's own energies
 * (HANDOFF §9.4): start mid, rise to the peak at 65%, ease off, cool down over the last 15%.
 */
export function energyCurve(x: number): number {
  if (x <= 0.65) return 0.5 + (0.5 * x) / 0.65;
  if (x <= 0.85) return 1 - (0.15 * (x - 0.65)) / 0.2;
  return 0.85 - (0.55 * (x - 0.85)) / 0.15;
}

/**
 * Per-position energy targets that the playlist can actually meet: positions ranked by curve
 * height get the playlist's energies of the same rank (ties: earlier position ranks lower).
 * Quantiles of the curve alone would ask for more high-energy tracks than the playlist has.
 */
function energyTargets(energies: readonly number[]): number[] {
  const n = energies.length;
  const sorted = [...energies].sort((a, b) => a - b);
  const curve = Array.from({ length: n }, (_, i) => energyCurve(n === 1 ? 0 : i / (n - 1)));
  const byHeight = curve
    .map((_, i) => i)
    .sort((a, b) => (curve[a] as number) - (curve[b] as number) || a - b);
  const targets = new Array<number>(n);
  byHeight.forEach((pos, rank) => {
    targets[pos] = sorted[rank] as number;
  });
  return targets;
}

/**
 * Order `tracks` along the energy curve: greedily place the track minimizing
 * |energy − target(i)| + λ·|Δtempo| that doesn't repeat the previous artist, then repair any
 * forced adjacency by swapping. Deterministic: ties go to the earlier entry of `tracks`.
 * `before`: the track just ahead of this list (the end of an earlier page), or -1.
 * Returns positions into `tracks`.
 */
export function sequence(
  columns: CatalogColumns,
  tracks: readonly number[],
  tempoLambda: number,
  before = -1,
): number[] {
  const n = tracks.length;
  const ei = columns.dimensions.scalar.indexOf("energy");
  const ti = columns.dimensions.scalar.indexOf("tempo");
  const order: number[] = [];
  if (n === 0) return order;
  const energyCol = ei >= 0 ? (columns.scalars[ei] as Float32Array) : null;
  const tempoCol = ti >= 0 ? (columns.scalars[ti] as Float32Array) : null;
  const energy = tracks.map((t) => (energyCol ? (energyCol[t] as number) : 0));
  const tempo = tracks.map((t) => (tempoCol ? (tempoCol[t] as number) : 0));
  const artist = tracks.map((t) => columns.artist[t] as number);
  const targets = energyTargets(energy);
  const beforeArtist = before >= 0 ? (columns.artist[before] as number) : -1;
  const beforeTempo = before >= 0 && tempoCol ? (tempoCol[before] as number) : 0;

  const left = new Set<number>(tracks.map((_, p) => p));
  for (let i = 0; i < n; i++) {
    const target = targets[i] as number;
    const prev = i > 0 ? (order[i - 1] as number) : -1;
    let best = -1;
    let bestCost = Number.POSITIVE_INFINITY;
    let fallback = -1;
    let fallbackCost = Number.POSITIVE_INFINITY;
    for (const p of left) {
      let cost = Math.abs((energy[p] as number) - target);
      if (prev >= 0) cost += tempoLambda * Math.abs((tempo[p] as number) - (tempo[prev] as number));
      else if (before >= 0) cost += tempoLambda * Math.abs((tempo[p] as number) - beforeTempo);
      const clash = prev >= 0 ? artist[p] === artist[prev] : artist[p] === beforeArtist;
      if (clash) {
        if (cost < fallbackCost || (cost === fallbackCost && p < fallback)) {
          fallback = p;
          fallbackCost = cost;
        }
      } else if (cost < bestCost || (cost === bestCost && p < best)) {
        best = p;
        bestCost = cost;
      }
    }
    const pick = best >= 0 ? best : fallback;
    order.push(pick);
    left.delete(pick);
  }
  repairAdjacency(order, artist, beforeArtist);
  return order;
}

/**
 * Swap away same-artist neighbors (position 0 also against `beforeArtist`): first swap partner
 * (lowest index) that leaves no clash.
 */
function repairAdjacency(order: number[], artist: readonly number[], beforeArtist: number): void {
  const n = order.length;
  const a = (pos: number) => (pos < 0 ? beforeArtist : artist[order[pos] as number]);
  const clashAt = (pos: number) =>
    (pos > 0 ? a(pos) === a(pos - 1) : a(pos) === beforeArtist) ||
    (pos < n - 1 && a(pos) === a(pos + 1));
  for (let i = beforeArtist >= 0 ? 0 : 1; i < n; i++) {
    if (a(i) !== a(i - 1)) continue;
    for (let k = 0; k < n; k++) {
      if (k === i || k === i - 1) continue;
      swap(order, i, k);
      if (!clashAt(i) && !clashAt(k)) break;
      swap(order, i, k);
    }
  }
}

function swap(xs: number[], i: number, j: number): void {
  const t = xs[i] as number;
  xs[i] = xs[j] as number;
  xs[j] = t;
}
