import {
  clampAdjust,
  type Dimensions,
  MAX_BLURB_CHARS,
  MAX_TITLE_CHARS,
  type TasteAdjust,
} from "@abtune/engine";
import { z } from "zod";
import { cleanText } from "../describe.ts";

/** What T1 Interpret and T3 Tweak return (HANDOFF §10.2), after clamping. */
export interface AiAdjustment {
  readonly adjust: TasteAdjust;
  readonly title: string | null;
  readonly blurb: string | null;
}

/** At most this many genres and decades per answer (the prompt asks for 6 and 4). */
const MAX_GENRES = 6;
const MAX_DECADES = 4;

/** The wire schema: enums from the bank's dimensions, so a constrained decoder can't invent keys. */
export function adjustSchema(dims: Dimensions): Record<string, unknown> {
  const list = (key: string, keys: readonly string[], value: string, max: number) => ({
    type: "array",
    maxItems: max,
    items: {
      type: "object",
      properties: { [key]: { type: "string", enum: [...keys] }, [value]: { type: "number" } },
      required: [key, value],
      additionalProperties: false,
    },
  });
  return {
    type: "object",
    properties: {
      scalar_deltas: list("dim", dims.scalar, "delta", dims.scalar.length),
      genre_boosts: list("genre", dims.genres, "boost", MAX_GENRES),
      decade_boosts: list("decade", dims.decades, "boost", MAX_DECADES),
      title: { type: "string", maxLength: MAX_TITLE_CHARS },
      blurb: { type: "string", maxLength: MAX_BLURB_CHARS },
    },
    required: ["scalar_deltas", "genre_boosts", "decade_boosts", "title", "blurb"],
    additionalProperties: false,
  };
}

/**
 * What we accept: the right shape with loose bounds. Keys and ranges are enforced afterwards by
 * clamping (an unknown key is dropped, 0.9 becomes 0.3), so a nearly right answer still counts.
 */
const answerSchema = z.object({
  scalar_deltas: z
    .array(z.object({ dim: z.string(), delta: z.number() }))
    .max(64)
    .optional(),
  genre_boosts: z
    .array(z.object({ genre: z.string(), boost: z.number() }))
    .max(64)
    .optional(),
  decade_boosts: z
    .array(z.object({ decade: z.string(), boost: z.number() }))
    .max(64)
    .optional(),
  title: z.string().max(1000).optional(),
  blurb: z.string().max(2000).optional(),
});

/** First value per key wins; later repeats are ignored. */
function toMap<T>(items: readonly T[], key: (x: T) => string, value: (x: T) => number) {
  const out: Record<string, number> = {};
  for (const x of items) if (!(key(x) in out)) out[key(x)] = value(x);
  return out;
}

export function parseAdjustment(dims: Dimensions, answer: unknown): AiAdjustment | null {
  const r = answerSchema.safeParse(answer);
  if (!r.success) return null;
  const a = r.data;
  const genres = toMap(
    (a.genre_boosts ?? []).filter((x) => dims.genres.includes(x.genre) && x.boost !== 0),
    (x) => x.genre,
    (x) => x.boost,
  );
  const decades = toMap(
    (a.decade_boosts ?? []).filter((x) => dims.decades.includes(x.decade) && x.boost !== 0),
    (x) => x.decade,
    (x) => x.boost,
  );
  const adjust = clampAdjust(dims, {
    scalar: toMap(
      a.scalar_deltas ?? [],
      (x) => x.dim,
      (x) => x.delta,
    ),
    // Only the first few, in the model's order: the prompt's limit, enforced.
    genres: Object.fromEntries(Object.entries(genres).slice(0, MAX_GENRES)),
    decades: Object.fromEntries(Object.entries(decades).slice(0, MAX_DECADES)),
  });
  return {
    adjust,
    title: cleanText(a.title, MAX_TITLE_CHARS),
    blurb: cleanText(a.blurb, MAX_BLURB_CHARS),
  };
}
