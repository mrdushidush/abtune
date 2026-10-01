import type { Bank, Question, QuestionOption } from "../src/index.ts";

const opt = (fx: Record<string, number>, label = "x"): QuestionOption => ({
  label,
  emoji: "•",
  fx,
});

export function q(
  id: string,
  pack: string,
  pri: number,
  a: Record<string, number>,
  b: Record<string, number>,
  extra: Partial<Question> = {},
): Question {
  return { id, pack, pri, weight: 1, a: opt(a, `${id}-a`), b: opt(b, `${id}-b`), ...extra };
}

export const PACKS: Bank["packs"] = {
  core: { weight: 1, default: true },
  context: { weight: 0.8, default: true },
  deep: { weight: 1, default: true },
  vibe: { weight: 0.4, default: true },
  spicy: { weight: 0.25, default: false, opt_in: true },
  community: { weight: 1, default: false },
};

export const DIMENSIONS: Bank["dimensions"] = {
  scalar: ["energy", "valence"],
  decades: ["dec80", "dec90"],
  genres: ["rock", "pop", "jazz", "metal"],
  languages: ["lang_en", "lang_fr"],
};

export function makeBank(questions: Question[]): Bank {
  return { version: 1, dimensions: DIMENSIONS, packs: PACKS, questions };
}
