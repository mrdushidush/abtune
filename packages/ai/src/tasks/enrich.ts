import { z } from "zod";
import { cleanText } from "../describe.ts";
import { loadPrompt, type Prompt, render } from "../prompts.ts";
import type { Task } from "../run.ts";

/**
 * T4 Enrich (HANDOFF §6.4 tier 4, §10.2): offline, a model rates catalog songs on the scalar dims
 * AcousticBrainz informs, for tracks that have no AcousticBrainz data. Catalog text only; no user
 * data, so its results may be cached on disk.
 */
export const ENRICH_DIMS = [
  "energy",
  "valence",
  "dance",
  "acoustic",
  "intensity",
  "tempo",
  "vocal",
] as const;
export type EnrichDim = (typeof ENRICH_DIMS)[number];

export interface EnrichSong {
  readonly title: string;
  readonly artist: string;
  readonly year: number | null;
  /** Display label, e.g. "Classic Rock". */
  readonly genre: string | null;
}

export interface EnrichInput {
  readonly songs: readonly EnrichSong[];
}

/** Per song (by position in the batch): ratings 1–5, or null when the model doesn't know it. */
export type EnrichResult = readonly (Readonly<Record<EnrichDim, number>> | null)[];

/** Songs per call: small enough for a quick answer, big enough to amortize the instructions. */
export const ENRICH_BATCH = 10;

const level = z.number().int().min(1).max(5);
const answerSchema = z.object({
  songs: z
    .array(
      z.object({
        n: z.number(),
        known: z.boolean(),
        ...Object.fromEntries(ENRICH_DIMS.map((d) => [d, level.optional()])),
      }),
    )
    .max(100),
});

export function enrichTask(prompt: Prompt = loadPrompt("enrich")): Task<EnrichInput, EnrichResult> {
  return {
    name: "enrich",
    prompt,
    user: (i) =>
      render(prompt.user, {
        count: String(i.songs.length),
        songs: i.songs
          .map((s, k) => {
            const meta = [s.year, s.genre].filter((x) => x !== null && x !== "").join(", ");
            return `${k + 1}. ${cleanText(s.title, 100) ?? "?"} — ${cleanText(s.artist, 80) ?? "?"}${meta ? ` (${meta})` : ""}`;
          })
          .join("\n"),
      }),
    schema: (i) => ({
      type: "object",
      properties: {
        songs: {
          type: "array",
          minItems: i.songs.length,
          maxItems: i.songs.length,
          items: {
            type: "object",
            properties: {
              n: { type: "integer", minimum: 1, maximum: i.songs.length },
              known: { type: "boolean" },
              ...Object.fromEntries(
                ENRICH_DIMS.map((d) => [d, { type: "integer", enum: [1, 2, 3, 4, 5] }]),
              ),
            },
            required: ["n", "known", ...ENRICH_DIMS],
            additionalProperties: false,
          },
        },
      },
      required: ["songs"],
      additionalProperties: false,
    }),
    // Pretty-printed, one song is ~60–70 tokens; a cut-off answer is invalid JSON.
    maxTokens: (i) => 64 + 110 * i.songs.length,
    parse: (answer, i) => {
      const r = answerSchema.safeParse(answer);
      if (!r.success) return null;
      const out: (Record<EnrichDim, number> | null)[] = i.songs.map(() => null);
      for (const s of r.data.songs) {
        const k = s.n - 1;
        if (!Number.isInteger(k) || k < 0 || k >= out.length || out[k] !== null || !s.known)
          continue;
        const levels = ENRICH_DIMS.map((d) => (s as Record<string, unknown>)[d]);
        if (levels.every((v) => typeof v === "number"))
          out[k] = Object.fromEntries(ENRICH_DIMS.map((d, j) => [d, levels[j]])) as Record<
            EnrichDim,
            number
          >;
      }
      return out;
    },
  };
}

/** Least squares y ≈ a + b·x. Null with fewer than 3 points or no spread in x. */
export function fitLine(
  xs: readonly number[],
  ys: readonly number[],
): { a: number; b: number } | null {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((s, x) => s + x, 0) / n;
  const my = ys.reduce((s, y) => s + y, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += ((xs[i] as number) - mx) ** 2;
    sxy += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
  }
  if (sxx === 0) return null;
  const b = sxy / sxx;
  return { a: my - b * mx, b };
}

/** Spearman rank correlation (average ranks for ties). */
export function spearman(xs: readonly number[], ys: readonly number[]): number {
  const rank = (v: readonly number[]) => {
    const order = v.map((x, i) => ({ x, i })).sort((p, q) => p.x - q.x);
    const r = new Array<number>(v.length);
    for (let i = 0; i < order.length; ) {
      let j = i;
      while (j + 1 < order.length && order[j + 1]?.x === order[i]?.x) j++;
      for (let k = i; k <= j; k++) r[(order[k] as { i: number }).i] = (i + j) / 2;
      i = j + 1;
    }
    return r;
  };
  const rx = rank(xs);
  const ry = rank(ys);
  const n = xs.length;
  const m = (n - 1) / 2;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += ((rx[i] as number) - m) * ((ry[i] as number) - m);
    sxx += ((rx[i] as number) - m) ** 2;
    syy += ((ry[i] as number) - m) ** 2;
  }
  return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : 0;
}
