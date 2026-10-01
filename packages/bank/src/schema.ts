import type { Dimensions } from "@abtune/engine";
import { z } from "zod";

// Value ranges, key validity and authoring rules are checked by lint (lint.ts) so the
// messages can name the offending key. The schema only checks shape and types.

const option = z.strictObject({
  label: z.string().min(1),
  emoji: z.string().min(1),
  fx: z.record(z.string(), z.number()),
});

const unlockIf = z.strictObject({
  any: z.array(z.string()).min(1).optional(),
  top_genres: z.array(z.string()).min(1).optional(),
});

const question = z.strictObject({
  id: z.string().min(1),
  pack: z.string().min(1),
  pri: z.number().int().min(0).max(100),
  q: z.string().min(1).optional(),
  weight: z.number().positive().optional(),
  sensitive: z.string().min(1).optional(),
  unlock_if: unlockIf.optional(),
  a: option,
  b: option,
});

const pack = z.strictObject({
  weight: z.number().positive(),
  default: z.boolean(),
  opt_in: z.boolean().optional(),
});

const dimensions = z.strictObject({
  scalar: z.array(z.string()).min(1),
  decades: z.array(z.string()).min(1),
  genres: z.array(z.string()).min(1),
  languages: z.array(z.string()).min(1),
});

/** One YAML file: the seed (with `dimensions`) or a community pack. */
export const bankFileSchema = z.strictObject({
  version: z.literal(1),
  dimensions: dimensions.optional(),
  packs: z.record(z.string(), pack).optional(),
  questions: z.array(question).optional(),
});

export type BankFileData = z.infer<typeof bankFileSchema>;

/**
 * JSON Schema for editor autocomplete (yaml-language-server). Stricter than the runtime
 * schema: fx keys are enumerated from the bank's dimensions and values are bounded.
 */
export function bankFileJsonSchema(dims: Dimensions): Record<string, unknown> {
  const fxKey = z.enum([...dims.scalar, ...dims.decades, ...dims.genres, ...dims.languages]);
  const strictOption = option.extend({
    label: z.string().min(1).max(22),
    fx: z.partialRecord(fxKey, z.number().min(-1).max(1)),
  });
  const strictUnlock = unlockIf.extend({
    any: z
      .array(z.string().regex(/^[a-z][a-z0-9_]*=(a|b)$/))
      .min(1)
      .optional(),
    top_genres: z.array(z.enum(dims.genres)).min(1).optional(),
  });
  const strictQuestion = question.extend({
    id: z.string().regex(/^[a-z][a-z0-9_]*$/),
    unlock_if: strictUnlock.optional(),
    a: strictOption,
    b: strictOption,
  });
  const schema = bankFileSchema.extend({ questions: z.array(strictQuestion).optional() });
  return {
    ...z.toJSONSchema(schema, { io: "input" }),
    title: "ABTune question bank file",
  };
}
