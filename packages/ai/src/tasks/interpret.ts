import type { Dimensions, TasteVector } from "@abtune/engine";
import { keyList, tasteSummary } from "../describe.ts";
import { loadPrompt, type Prompt, render } from "../prompts.ts";
import type { Task } from "../run.ts";
import { type AiAdjustment, adjustSchema, parseAdjustment } from "./adjust.ts";

export interface InterpretInput {
  readonly dims: Dimensions;
  /** The engine's profile (before any AI adjustment). */
  readonly taste: TasteVector;
  /** From `answerLines`, already filtered by `answersForAi`. */
  readonly answers: readonly string[];
}

/** Keeps the prompt under ~4k tokens (§10.1): the most answers a 100-question quiz plus "10 more" has. */
export const MAX_AI_ANSWERS = 150;

/** T1 Interpret (HANDOFF §10.2): read the answers together and nudge the profile. */
export function interpretTask(
  prompt: Prompt = loadPrompt("interpret"),
): Task<InterpretInput, AiAdjustment> {
  return {
    name: "interpret",
    prompt,
    user: (i) => {
      const answers = i.answers.slice(-MAX_AI_ANSWERS);
      return render(prompt.user, {
        profile: tasteSummary(i.dims, i.taste),
        keys: keyList(i.dims),
        count: String(answers.length),
        answers: answers.join("\n"),
      });
    },
    schema: (i) => adjustSchema(i.dims),
    maxTokens: () => 600,
    parse: (answer, i) => parseAdjustment(i.dims, answer),
  };
}
