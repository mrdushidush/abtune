import type { Dimensions, TasteVector } from "@abtune/engine";
import { cleanText, keyList, tasteSummary } from "../describe.ts";
import { loadPrompt, type Prompt, render } from "../prompts.ts";
import type { Task } from "../run.ts";
import { type AiAdjustment, adjustSchema, parseAdjustment } from "./adjust.ts";

/** Longest free-text tweak ("rainy Sunday", "for a 5k run"). */
export const MAX_TWEAK_TEXT = 200;

export interface TweakInput {
  readonly dims: Dimensions;
  /** The profile the request applies to (the card taste). */
  readonly taste: TasteVector;
  readonly request: string;
}

/** The request as it goes into the prompt: one line, at most MAX_TWEAK_TEXT characters. */
export function cleanRequest(text: unknown): string | null {
  return cleanText(text, MAX_TWEAK_TEXT);
}

/** T3 Tweak (HANDOFF §10.2): a free-text request → the same bounded adjustment as T1. */
export function tweakTask(prompt: Prompt = loadPrompt("tweak")): Task<TweakInput, AiAdjustment> {
  return {
    name: "tweak",
    prompt,
    user: (i) =>
      render(prompt.user, {
        profile: tasteSummary(i.dims, i.taste),
        keys: keyList(i.dims),
        request: JSON.stringify(i.request),
      }),
    schema: (i) => adjustSchema(i.dims),
    maxTokens: () => 600,
    parse: (answer, i) => parseAdjustment(i.dims, answer),
  };
}
