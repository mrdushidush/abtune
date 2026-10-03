import {
  type AiAdjustment,
  type AiRuntime,
  type AiSettings,
  answerLines,
  cleanRequest,
  interpretTask,
  MAX_TWEAK_TEXT,
  runTask,
  tweakTask,
} from "@abtune/ai";
import { answersForAi, type Bank, bankIndex, type Choice, type TasteVector } from "@abtune/engine";
import type { Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import {
  type AiAdjustResponse,
  type AiAnswer,
  type AiHealth,
  type ApiError,
  MAX_AI_REQUEST_ANSWERS,
} from "../api-types.ts";
import { sameOrigin } from "./http.ts";
import { parseTaste } from "./playlist.ts";

/** The AI layer on this server: settings from `.env` and the runtime (null when off). */
export interface ServerAi {
  readonly settings: AiSettings;
  readonly runtime: AiRuntime | null;
}

export function aiHealth({ settings, runtime }: ServerAi): AiHealth {
  return {
    enabled: runtime !== null,
    rerank: runtime !== null && settings.rerank,
    sensitive_opt_in: runtime !== null && settings.allowSensitive,
    model: runtime ? settings.model : null,
  };
}

/** Answers plus a taste vector: far below this. */
export const MAX_AI_BODY_BYTES = 32 * 1024;

const CHOICES: readonly Choice[] = ["a", "b", "both", "skip"];
const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === "object" && x !== null && !Array.isArray(x);

const fail = (c: Context, status: 400 | 403 | 409 | 413 | 502 | 503, body: ApiError) =>
  c.json(body, status);

function adjustBody(v: AiAdjustment, sent?: AiAdjustResponse["sent"]): AiAdjustResponse {
  return { adjust: v.adjust, title: v.title, blurb: v.blurb, ...(sent ? { sent } : {}) };
}

/**
 * HANDOFF §10.2 T1 Interpret and T3 Tweak. The browser sends what the model may see, and the server
 * checks again: a sensitive answer reaches the model only with the session's opt-in *and*
 * ALLOW_SENSITIVE_TO_AI (§13). Bodies, prompts and answers are never logged; failures are logged by
 * kind only. A failure is a 502 the client turns into the classic playlist with a notice.
 */
export function mountAi(
  app: Hono,
  { ai, bank, engine }: { ai: ServerAi; bank: Bank; engine: string },
) {
  const { byId } = bankIndex(bank);
  const limit = bodyLimit({
    maxSize: MAX_AI_BODY_BYTES,
    onError: (c) => fail(c, 413, { error: "too_large", message: "Request body too large." }),
  });

  /** The parts every AI request shares; a Response when the request can't go on. */
  async function common(
    c: Context,
  ): Promise<
    | { ok: true; body: Record<string, unknown>; taste: TasteVector; runtime: AiRuntime }
    | { ok: false; res: Response }
  > {
    if (!sameOrigin(c)) return { ok: false, res: fail(c, 403, { error: "cross_site" }) };
    const runtime = ai.runtime;
    if (!runtime)
      return {
        ok: false,
        res: fail(c, 503, { error: "ai_off", message: "AI is off on this server." }),
      };
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return {
        ok: false,
        res: fail(c, 400, { error: "bad_request", message: "Body must be JSON." }),
      };
    }
    if (!isObject(body))
      return {
        ok: false,
        res: fail(c, 400, { error: "bad_request", message: "Body must be a JSON object." }),
      };
    if (body.engine_version !== engine)
      return {
        ok: false,
        res: fail(c, 409, { error: "version_mismatch", engine_version: engine }),
      };
    const taste = parseTaste(body.taste, bank.dimensions);
    if (!taste.ok)
      return { ok: false, res: fail(c, 400, { error: "bad_request", message: taste.message }) };
    return { ok: true, body, taste: taste.value, runtime };
  }

  app.post("/api/ai/interpret", limit, async (c) => {
    const req = await common(c);
    if (!req.ok) return req.res;
    const { answers, include_sensitive } = req.body;
    if (
      !Array.isArray(answers) ||
      answers.length > MAX_AI_REQUEST_ANSWERS ||
      !answers.every(
        (a): a is AiAnswer =>
          isObject(a) &&
          typeof a.id === "string" &&
          a.id.length <= 200 &&
          CHOICES.includes(a.choice as Choice),
      )
    )
      return fail(c, 400, {
        error: "bad_request",
        message: `answers must be at most ${MAX_AI_REQUEST_ANSWERS} {id, choice} pairs.`,
      });
    if (include_sensitive !== undefined && typeof include_sensitive !== "boolean")
      return fail(c, 400, {
        error: "bad_request",
        message: "include_sensitive must be a boolean.",
      });
    const optIn = include_sensitive === true && ai.settings.allowSensitive;
    const allowed = answersForAi(bank, answers, optIn);
    const r = await runTask(
      req.runtime,
      interpretTask(),
      { dims: bank.dimensions, taste: req.taste, answers: answerLines(bank, allowed) },
      c.req.raw.signal,
    );
    if (!r.ok) return fail(c, 502, { error: "ai_failed", reason: r.failure });
    const sensitive = allowed.filter((a) => byId.get(a.id)?.sensitive !== undefined).length;
    return c.json(adjustBody(r.value, { answers: allowed.length, sensitive }));
  });

  app.post("/api/ai/tweak", limit, async (c) => {
    const req = await common(c);
    if (!req.ok) return req.res;
    const raw = req.body.text;
    const text =
      typeof raw === "string" && raw.length <= 4 * MAX_TWEAK_TEXT ? cleanRequest(raw) : null;
    if (!text)
      return fail(c, 400, {
        error: "bad_request",
        message: `text must be 1–${MAX_TWEAK_TEXT} characters.`,
      });
    const r = await runTask(
      req.runtime,
      tweakTask(),
      { dims: bank.dimensions, taste: req.taste, request: text },
      c.req.raw.signal,
    );
    if (!r.ok) return fail(c, 502, { error: "ai_failed", reason: r.failure });
    return c.json(adjustBody(r.value));
  });
}
