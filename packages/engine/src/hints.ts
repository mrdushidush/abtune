import { P_SCALE, TARGET_SCALE, type TasteVector, WEIGHT_SCALE } from "./taste.ts";
import type { Dimensions } from "./types.ts";

/**
 * A live hint about the profile so far (HANDOFF §4.2: "Era locking in: 80s–90s"). Structured, not
 * text: the UI words it, so hints can be translated.
 */
export type Hint =
  /** One decade, or two adjacent ones in chronological order. */
  | { readonly kind: "era"; readonly decades: readonly string[] }
  /** The top genre, or the top two when they are close. */
  | { readonly kind: "genre"; readonly genres: readonly string[] }
  /** A scalar with a clear lean toward one end. */
  | { readonly kind: "scalar"; readonly dim: string; readonly pole: "low" | "high" }
  /** A language other than English with most of the mass. */
  | { readonly kind: "language"; readonly language: string };

/** Scalars worth a hint, in priority order (the rest are too abstract to call out mid-quiz). */
export const HINT_SCALARS: readonly string[] = [
  "energy",
  "valence",
  "dance",
  "acoustic",
  "tempo",
  "mainstream",
];

// Era shares must clear both an absolute floor and a multiple of the uniform share, so a bank
// with few decades doesn't call a near-uniform spread "locking in".
const ERA_SINGLE = 0.35;
const ERA_SINGLE_X_UNIFORM = 2.8;
const ERA_NEIGHBOR = 0.15;
const ERA_PAIR = 0.45;
const ERA_PAIR_X_UNIFORM = 1.8;
const GENRE_TOP = 0.35;
const GENRE_SECOND = 0.25;
const SCALAR_LEAN = 0.4;
const SCALAR_CONFIDENCE = 0.6;
const LANGUAGE_TOP = 0.5;
/** The bank's default-market language: leaning into it isn't news. */
const BASE_LANGUAGE = "lang_en";

/** Stable identity of a hint, for "already shown" bookkeeping. */
export function hintKey(h: Hint): string {
  switch (h.kind) {
    case "era":
      return `era:${h.decades.join("+")}`;
    case "genre":
      return `genre:${h.genres.join("+")}`;
    case "scalar":
      return `scalar:${h.dim}:${h.pole}`;
    case "language":
      return `language:${h.language}`;
  }
}

function eraHint(keys: readonly string[], p: readonly number[] | null): Hint | null {
  if (!p) return null;
  const at = (i: number) => (p[i] ?? 0) / P_SCALE;
  const single = Math.max(ERA_SINGLE, ERA_SINGLE_X_UNIFORM / keys.length);
  const pair = Math.max(ERA_PAIR, (ERA_PAIR_X_UNIFORM * 2) / keys.length);
  let top = 0;
  p.forEach((_, i) => {
    if (at(i) > at(top)) top = i;
  });
  if (at(top) >= single) {
    const next = at(top - 1) > at(top + 1) ? top - 1 : top + 1;
    if (at(next) >= ERA_NEIGHBOR) {
      const [a, b] = next < top ? [next, top] : [top, next];
      return { kind: "era", decades: [keys[a] as string, keys[b] as string] };
    }
    return { kind: "era", decades: [keys[top] as string] };
  }
  // Sum the integer shares before scaling, so 300 + 600 is exactly 0.9.
  const both = (i: number) => ((p[i] ?? 0) + (p[i + 1] ?? 0)) / P_SCALE;
  let best = -1;
  for (let i = 0; i + 1 < keys.length; i++) {
    if (both(i) >= pair && (best < 0 || both(i) > both(best))) best = i;
  }
  return best < 0
    ? null
    : { kind: "era", decades: [keys[best] as string, keys[best + 1] as string] };
}

function genreHint(keys: readonly string[], p: readonly number[] | null): Hint | null {
  if (!p) return null;
  const ranked = keys
    .map((key, i) => ({ key, i, p: (p[i] ?? 0) / P_SCALE }))
    .sort((x, y) => y.p - x.p || x.i - y.i);
  const [first, second] = ranked;
  if (!first || first.p < GENRE_TOP) return null;
  return second && second.p >= GENRE_SECOND
    ? { kind: "genre", genres: [first.key, second.key] }
    : { kind: "genre", genres: [first.key] };
}

/**
 * Hints that hold for `taste`, most interesting first: genre, era, language, then scalars.
 * Pure; the UI decides which one to show (e.g. the first that wasn't true one answer ago).
 */
export function profileHints(dims: Dimensions, taste: TasteVector): Hint[] {
  const out: Hint[] = [];
  const genre = genreHint(dims.genres, taste.genres);
  if (genre) out.push(genre);
  const era = eraHint(dims.decades, taste.decades);
  if (era) out.push(era);
  if (taste.languages) {
    dims.languages.forEach((key, i) => {
      if (
        key !== BASE_LANGUAGE &&
        ((taste.languages as number[])[i] ?? 0) / P_SCALE >= LANGUAGE_TOP
      )
        out.push({ kind: "language", language: key });
    });
  }
  for (const dim of HINT_SCALARS) {
    const i = dims.scalar.indexOf(dim);
    if (i < 0) continue;
    const t = (taste.target[i] ?? 0) / TARGET_SCALE;
    const k = (taste.weight[i] ?? 0) / WEIGHT_SCALE;
    if (k >= SCALAR_CONFIDENCE && Math.abs(t) >= SCALAR_LEAN)
      out.push({ kind: "scalar", dim, pole: t > 0 ? "high" : "low" });
  }
  return out;
}
