// Client state: the engine session (HANDOFF §8.1: config + answer log + seed salt) plus tweaks.
// Everything else (screen, profile, playlist request) is derived. Lives in localStorage only.
import {
  addTweak,
  type Bank,
  createSession,
  engineVersion,
  LENGTHS,
  MODES,
  reduceSession,
  type SessionAction,
  type SessionState,
  type TweakAxis,
  type TweakId,
  type TweakSteps,
  validateLog,
  validateTweaks,
  viewSession,
} from "@abtune/engine";

export interface SetupChoice {
  readonly mode: number;
  readonly length: number;
  readonly packs: readonly string[];
}

export interface AppState {
  readonly session: SessionState | null;
  readonly tweaks: TweakSteps;
  /** The last setup, offered again after "Start over". */
  readonly setup: SetupChoice | null;
  /** Question ids of the last finished session: the next one asks other variants (D7). */
  readonly recent: readonly string[];
}

export type AppAction =
  /** `quizSeed`: 16 random hex chars from the caller (the reducer stays pure). */
  | { readonly type: "start"; readonly setup: SetupChoice; readonly quizSeed: string }
  | { readonly type: "session"; readonly action: SessionAction }
  | { readonly type: "tweak"; readonly id: TweakId }
  | { readonly type: "untweak"; readonly axis: TweakAxis }
  | { readonly type: "reset_tweaks" }
  | { readonly type: "restart" };

export type Screen = "setup" | "quiz" | "result";

export const EMPTY_STATE: AppState = { session: null, tweaks: {}, setup: null, recent: [] };

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
    x.packs.every((p) => typeof p === "string" && p in bank.packs)
  );
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
    if (!session) return { session: null, tweaks: {}, setup, recent };
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
      (config.avoid !== undefined && !Array.isArray(config.avoid))
    )
      return { session: null, tweaks: {}, setup, recent };
    // A bank edit can remove questions the saved log references.
    if (stored.engine_version !== engineVersion(bank)) validateLog(bank, session.answer_log);
    return { session, tweaks, setup, recent };
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
