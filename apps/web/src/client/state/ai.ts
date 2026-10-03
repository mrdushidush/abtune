// The AI layer in the browser (HANDOFF §10, M7): what the result screen shows for a session's AI
// state, and the two calls. Answers leave the device only here, filtered by `answersForAi` (no
// sensitive ones without the opt-in, §13); the server filters again.
import {
  answersForAi,
  applyAdjust,
  type Bank,
  engineVersion,
  playlistBase,
  type SessionState,
  type TasteAdjust,
  type TasteVector,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import type {
  AiAdjustResponse,
  AiFailureCode,
  ApiError,
  InterpretRequest,
  TextTweakRequest,
} from "../../api-types.ts";
import { call } from "./api.ts";
import { type AiInterpretation, type AiState, aiKey } from "./app.ts";

/** Everything the result screen derives from the session's AI state. */
export interface AiView {
  /** This session asked for AI and the server has a model. */
  readonly on: boolean;
  /** T1 hasn't answered for these answers yet: hold the playlist. */
  readonly pending: boolean;
  readonly key: string;
  /** T1's outcome for these answers (null while pending, or with AI off). */
  readonly interpret: AiInterpretation | null;
  /** The engine profile, with T1's adjustment when there is one. The card shows this. */
  readonly card: TasteVector;
  /** T3's adjustment: the playlist's base is the card taste with it (`playlistBase`). */
  readonly textAdjust: TasteAdjust | null;
  readonly base: TasteVector;
  /** T3's title over T1's; null = the engine's title. */
  readonly title: string | null;
  readonly blurb: string | null;
  /** What a share link may carry: never a title or blurb made from sensitive answers. */
  readonly shareTitle: string | null;
  readonly shareBlurb: string | null;
}

export function aiView(
  bank: Bank,
  session: SessionState,
  ai: AiState | null,
  serverHasAi: boolean,
): AiView {
  const engine = tasteVector(bank, viewSession(bank, session).profile);
  const key = aiKey(bank, session);
  const on = ai !== null && serverHasAi;
  const interpret = on && ai.key === key ? ai.interpret : null;
  const done = interpret?.status === "done" ? interpret : null;
  const card = done ? applyAdjust(bank.dimensions, engine, done.adjust) : engine;
  const text = on ? ai.text : null;
  const t1Shareable = done && !done.sensitive ? done : null;
  return {
    on,
    pending: on && interpret === null,
    key,
    interpret,
    card,
    textAdjust: text?.adjust ?? null,
    base: playlistBase(bank.dimensions, card, text?.adjust),
    title: text?.title ?? done?.title ?? null,
    blurb: text?.blurb ?? done?.blurb ?? null,
    shareTitle: text?.title ?? t1Shareable?.title ?? null,
    shareBlurb: text?.blurb ?? t1Shareable?.blurb ?? null,
  };
}

/** The T1 request: filtered answers and the engine's profile. */
export function interpretRequest(
  bank: Bank,
  session: SessionState,
  optIn: boolean,
): InterpretRequest {
  return {
    engine_version: engineVersion(bank),
    answers: answersForAi(bank, session.answer_log, optIn).map((e) => ({
      id: e.id,
      choice: e.choice,
    })),
    taste: tasteVector(bank, viewSession(bank, session).profile),
    ...(optIn ? { include_sensitive: true } : {}),
  };
}

const postJson = (url: string, body: unknown, signal?: AbortSignal) =>
  call<AiAdjustResponse, ApiError>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: signal ?? null,
  });

export const postInterpret = (req: InterpretRequest, signal?: AbortSignal) =>
  postJson("/api/ai/interpret", req, signal);

export const postTextTweak = (req: TextTweakRequest, signal?: AbortSignal) =>
  postJson("/api/ai/tweak", req, signal);

/** A failed call's reason for the notice: the server's, or "unreachable" when it gave none. */
export function failureOf(error: ApiError | null): AiFailureCode {
  if (error?.error === "ai_off") return "off";
  return error?.reason ?? "unreachable";
}
