import type { Dimensions, TasteVector } from "@abtune/engine";
import { z } from "zod";
import { cleanText, tasteSummary } from "../describe.ts";
import { loadPrompt, type Prompt, render } from "../prompts.ts";
import type { Task } from "../run.ts";

/** One shortlist song as the model sees it (§10.2 T2: catalog text only, never an id). */
export interface RerankSong {
  readonly title: string;
  readonly artist: string;
  readonly year: number | null;
  /** Display label, e.g. "Classic Rock". */
  readonly genre: string | null;
}

export interface RerankInput {
  readonly dims: Dimensions;
  readonly taste: TasteVector;
  readonly songs: readonly RerankSong[];
  /** Songs to pick. */
  readonly n: number;
  /** The AI title and blurb, when T1/T3 made them: what this playlist is for. */
  readonly title?: string | null;
  readonly blurb?: string | null;
}

export interface RerankResult {
  /** Shortlist positions (0-based), the model's best first; only valid, distinct ones. */
  readonly order: readonly number[];
  /** Short "why" per position, for the rows that get one. */
  readonly notes: Readonly<Record<number, string>>;
}

/** The "why" chip (§4.3, §10.2: ≤ 80 characters). */
export const MAX_NOTE_CHARS = 80;

const answerSchema = z.object({
  picks: z.array(z.object({ n: z.number(), why: z.string().max(1000).optional() })).max(400),
});

function songLine(s: RerankSong, i: number): string {
  const meta = [s.year, s.genre].filter((x) => x !== null && x !== "").join(", ");
  const title = cleanText(s.title, 100) ?? "?";
  const artist = cleanText(s.artist, 80) ?? "?";
  return `${i + 1}. ${title} — ${artist}${meta ? ` (${meta})` : ""}`;
}

/** T2 Rerank (HANDOFF §10.2): choose from a numbered shortlist, with a "why" per pick. */
export function rerankTask(prompt: Prompt = loadPrompt("rerank")): Task<RerankInput, RerankResult> {
  return {
    name: "rerank",
    prompt,
    user: (i) => {
      const context = [
        i.title ? `Playlist: ${JSON.stringify(i.title)}` : "",
        i.blurb ? `About it: ${JSON.stringify(i.blurb)}` : "",
      ]
        .filter(Boolean)
        .join("\n");
      return render(prompt.user, {
        profile: tasteSummary(i.dims, i.taste),
        context: context ? `${context}\n` : "",
        size: String(i.songs.length),
        songs: i.songs.map(songLine).join("\n"),
        n: String(i.n),
      });
    },
    schema: (i) => ({
      type: "object",
      properties: {
        picks: {
          type: "array",
          maxItems: i.n,
          items: {
            type: "object",
            properties: {
              n: { type: "integer", minimum: 1, maximum: i.songs.length },
              why: { type: "string", maxLength: MAX_NOTE_CHARS },
            },
            required: ["n", "why"],
            additionalProperties: false,
          },
        },
      },
      required: ["picks"],
      additionalProperties: false,
    }),
    // Measured with a local Qwen 3.6 35B-A3B: ~25–35 tokens per pick (pretty-printed JSON), ~58
    // tokens/s. A cut-off answer is invalid JSON, so the budget leaves room.
    maxTokens: (i) => 96 + 40 * i.n,
    /** 20 s (the default) per 25 songs. */
    timeoutFactor: (i) => Math.ceil(i.n / 25),
    parse: (answer, i) => {
      const r = answerSchema.safeParse(answer);
      if (!r.success) return null;
      const order: number[] = [];
      const notes: Record<number, string> = {};
      for (const pick of r.data.picks) {
        const p = pick.n - 1;
        // Hallucinated numbers (outside the list, fractions, repeats) are dropped.
        if (!Number.isInteger(p) || p < 0 || p >= i.songs.length || order.includes(p)) continue;
        order.push(p);
        const why = cleanText(pick.why, MAX_NOTE_CHARS);
        if (why) notes[p] = why;
      }
      return order.length > 0 ? { order, notes } : null;
    },
  };
}
