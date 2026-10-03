// Client state: the engine session (HANDOFF §8.1: config + answer log + seed salt) plus tweaks and
// what the AI layer answered. Everything else (screen, profile, playlist request) is derived.
// Lives in localStorage only.
import {
  addTweak,
  type Bank,
  canonicalJson,
  createSession,
  engineVersion,
  LENGTHS,
  MODES,
  reduceSession,
  type SessionAction,
  type SessionState,
  sha256Hex,
  type TasteAdjust,
  type TweakAxis,
  type TweakId,
  type TweakSteps,
  validateAdjust,
  validateLog,
  validateTweaks,
  viewSession,
} from "@abtune/engine";
import type { AiFailureCode } from "../../api-types.ts";

export interface SetupChoice {
  readonly mode: number;
  readonly length: number;
  readonly packs: readonly string[];
  /** "AI touches" (HANDOFF §4.1): only offered when the server has a model. */
  readonly ai?: boolean;
  /** The per-session opt-in to send sensitive answers too (§10.4, §13). */
  readonly aiSensitive?: boolean;
}

/** What an AI call made: a bounded adjustment, and maybe a title and blurb (HANDOFF §10.2). */
export interface AiMade {
  readonly adjust: TasteAdjust;
  readonly title: string | null;
  readonly blurb: string | null;
}

/** T1 Interpret's outcome for one answer log. */
export type AiInterpretation =
  | (AiMade & {
      readonly status: "done";
      /** A sensitive answer went to the model: its title and blurb stay out of share links. */
      readonly sensitive: boolean;
    })
  | { readonly status: "failed"; readonly reason: AiFailureCode }
  /** The listener chose not to wait. */
  | { readonly status: "skipped" };

/** The AI layer for a session that has it on. */
export interface AiState {
  readonly optIn: boolean;
  /** `aiKey` of the answers `interpret` is for; new answers ("10 more") interpret again. */
  readonly key: string | null;
  readonly interpret: AiInterpretation | null;
  /** T3: the free-text tweak in effect. */
  readonly text: (AiMade & { readonly text: string }) | null;
}

export interface AppState {
  readonly session: SessionState | null;
  readonly tweaks: TweakSteps;
  /** The last setup, offered again after "Start over". */
  readonly setup: SetupChoice | null;
  /** Question ids of the last finished session: the next one asks other variants (D7). */
  readonly recent: readonly string[];
  /** Null when this session has AI off. */
  readonly ai: AiState | null;
}

export type AppAction =
  /** `quizSeed`: 16 random hex chars from the caller (the reducer stays pure). */
  | { readonly type: "start"; readonly setup: SetupChoice; readonly quizSeed: string }
  | { readonly type: "session"; readonly action: SessionAction }
  | { readonly type: "tweak"; readonly id: TweakId }
  | { readonly type: "untweak"; readonly axis: TweakAxis }
  | { readonly type: "reset_tweaks" }
  | { readonly type: "restart" }
  | { readonly type: "ai_interpret"; readonly key: string; readonly result: AiInterpretation }
  /** Ask the model again after a failure. */
  | { readonly type: "ai_retry" }
  | { readonly type: "ai_text"; readonly text: (AiMade & { readonly text: string }) | null };

export type Screen = "setup" | "quiz" | "result";

export const EMPTY_STATE: AppState = {
  session: null,
  tweaks: {},
  setup: null,
  recent: [],
  ai: null,
};

/** Which answers an interpretation is for: the engine version and the answer log. */
export function aiKey(bank: Bank, session: SessionState): string {
  return sha256Hex(canonicalJson([engineVersion(bank), session.answer_log])).slice(0, 16);
}

/** A fresh quiz seed: 64 random bits as 16 hex chars. */
export function randomQuizSeed(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function screenOf(bank: Bank, state: AppState): Screen {
  if (!state.session) return "setup";
  return viewSession(bank, state.session).status === "asking" ? "quiz" : "result";
}

export function appReducer(bank: Bank, state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case "start":
      return {
        session: createSession(bank, {
          ...action.setup,
          packs: [...action.setup.packs],
          quiz_seed: action.quizSeed,
          avoid: state.recent,
        }),
        tweaks: {},
        setup: action.setup,
        recent: state.recent,
        ai: action.setup.ai
          ? { optIn: action.setup.aiSensitive === true, key: null, interpret: null, text: null }
          : null,
      };
    case "session": {
      if (!state.session) return state;
      try {
        return { ...state, session: reduceSession(bank, state.session, action.action) };
      } catch {
        // A stale or double tap (e.g. answering a card that already moved on): ignore it.
        return state;
      }
    }
    case "tweak":
      return { ...state, tweaks: addTweak(state.tweaks, action.id) };
    case "untweak": {
      const { [action.axis]: _, ...rest } = state.tweaks;
      return { ...state, tweaks: rest };
    }
    case "reset_tweaks":
      return { ...state, tweaks: {} };
    case "restart":
      return {
        ...EMPTY_STATE,
        setup: state.setup,
        recent: state.session ? state.session.answer_log.map((e) => e.id) : state.recent,
      };
    case "ai_interpret":
      return state.ai
        ? { ...state, ai: { ...state.ai, key: action.key, interpret: action.result } }
        : state;
    case "ai_retry":
      return state.ai ? { ...state, ai: { ...state.ai, key: null, interpret: null } } : state;
    case "ai_text":
      return state.ai ? { ...state, ai: { ...state.ai, text: action.text } } : state;
  }
}

export const STORAGE_KEY = "abtune.app.v1";

interface Stored {
  readonly v: 1;
  readonly engine_version: string;
  readonly state: AppState;
}

/** Storage can throw (private mode, blocked site data) or be missing: never fatal. */
function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function validSetup(bank: Bank, s: unknown): s is SetupChoice {
  const x = s as SetupChoice;
  return (
    typeof x === "object" &&
    x !== null &&
    (MODES as readonly number[]).includes(x.mode) &&
    (LENGTHS as readonly number[]).includes(x.length) &&
    Array.isArray(x.packs) &&
    x.packs.every((p) => typeof p === "string" && p in bank.packs) &&
    (x.ai === undefined || typeof x.ai === "boolean") &&
    (x.aiSensitive === undefined || typeof x.aiSensitive === "boolean")
  );
}

const isText = (x: unknown, max: number) => typeof x === "string" && x.length <= max;
const nullableText = (x: unknown) => x === null || isText(x, 400);

function validMade(bank: Bank, x: unknown): x is AiMade {
  const m = x as AiMade;
  if (typeof m !== "object" || m === null || !nullableText(m.title) || !nullableText(m.blurb))
    return false;
  try {
    validateAdjust(bank.dimensions, m.adjust);
    return true;
  } catch {
    return false;
  }
}

/** A saved AI record, or null when any part of it is unusable for this bank. */
function restoreAi(bank: Bank, x: unknown): AiState | null {
  const a = x as AiState;
  if (typeof a !== "object" || a === null || typeof a.optIn !== "boolean") return null;
  if (a.key !== null && !(typeof a.key === "string" && /^[0-9a-f]{16}$/.test(a.key))) return null;
  const i = a.interpret;
  const interpretOk =
    i === null ||
    (typeof i === "object" &&
      ((i.status === "done" && validMade(bank, i) && typeof i.sensitive === "boolean") ||
        (i.status === "failed" && typeof i.reason === "string") ||
        i.status === "skipped"));
  const textOk = a.text === null || (validMade(bank, a.text) && isText(a.text.text, 400));
  return interpretOk && textOk ? a : { optIn: a.optIn, key: null, interpret: null, text: null };
}

/** Parse what was saved; anything unusable for this bank is dropped rather than trusted. */
export function restoreState(bank: Bank, raw: string | null): AppState {
  if (!raw) return EMPTY_STATE;
  try {
    const stored = JSON.parse(raw) as Stored;
    if (stored?.v !== 1 || typeof stored.state !== "object") return EMPTY_STATE;
    const setup = validSetup(bank, stored.state.setup) ? stored.state.setup : null;
    const recent = Array.isArray(stored.state.recent)
      ? stored.state.recent.filter((id): id is string => typeof id === "string")
      : [];
    const session = stored.state.session;
    let tweaks: TweakSteps = {};
    try {
      validateTweaks(stored.state.tweaks ?? {});
      tweaks = stored.state.tweaks ?? {};
    } catch {}
    if (!session) return { ...EMPTY_STATE, setup, recent };
    const { config } = session;
    if (
      !Number.isInteger(config?.mode) ||
      config.mode < 1 ||
      !(LENGTHS as readonly number[]).includes(config.length) ||
      !Array.isArray(config.packs) ||
      !config.packs.every((p) => p in bank.packs) ||
      !Number.isInteger(session.seed_salt) ||
      !Array.isArray(session.answer_log) ||
      (config.quiz_seed != null && !/^[0-9a-f]{16}$/.test(config.quiz_seed)) ||
      (config.avoid !== undefined && !Array.isArray(config.avoid)) ||
      typeof config.ai !== "boolean"
    )
      return { ...EMPTY_STATE, setup, recent };
    // A bank edit can remove questions the saved log references.
    if (stored.engine_version !== engineVersion(bank)) validateLog(bank, session.answer_log);
    const ai = config.ai ? restoreAi(bank, stored.state.ai) : null;
    return { session, tweaks, setup, recent, ai };
  } catch {
    return EMPTY_STATE;
  }
}

export function loadState(bank: Bank): AppState {
  try {
    return restoreState(bank, storage()?.getItem(STORAGE_KEY) ?? null);
  } catch {
    return EMPTY_STATE;
  }
}

export function saveState(bank: Bank, state: AppState): void {
  try {
    const stored: Stored = { v: 1, engine_version: engineVersion(bank), state };
    storage()?.setItem(STORAGE_KEY, JSON.stringify(stored));
  } catch {
    // Quota or blocked storage: the session just won't survive a reload.
  }
}
