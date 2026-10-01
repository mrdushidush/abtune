import { bankIndex } from "./dims.ts";
import { type AnswerEvent, foldProfile, type Profile } from "./profile.ts";
import { computeSeed } from "./seed.ts";
import { nextQuestion } from "./select.ts";
import type { Bank, Choice, Question } from "./types.ts";
import { engineVersion } from "./version.ts";

export const MODES = [10, 20, 50, 100] as const;
export const LENGTHS = [25, 50, 100] as const;
/** "Answer 10 more" step (HANDOFF §8.1). */
export const MORE_STEP = 10;

export interface SessionConfig {
  /** Target number of non-skip answers. 10/20/50/100, raised in steps of 10 by "10 more". */
  readonly mode: number;
  /** Playlist length. */
  readonly length: number;
  /** Enabled packs, sorted. */
  readonly packs: readonly string[];
  readonly ai: boolean;
}

/** HANDOFF §8.1: the whole session. Everything else is derived. */
export interface SessionState {
  readonly config: SessionConfig;
  readonly answer_log: readonly AnswerEvent[];
  readonly seed_salt: number;
}

export type SessionAction =
  /** Answer the current question. Pass `id` to guard against answering a stale card. */
  | { readonly type: "answer"; readonly choice: Choice; readonly id?: string }
  /** Undo the last log event (skips included). */
  | { readonly type: "back" }
  /** Raise the mode by 10 and keep asking. */
  | { readonly type: "ten_more" }
  /** Same profile, new playlist seed. */
  | { readonly type: "reshuffle" };

export type SessionStatus = "asking" | "profile_ready" | "exhausted";

export interface SessionView {
  /** `exhausted`: the bank ran out of eligible questions before reaching the mode. */
  readonly status: SessionStatus;
  /** The card to show while asking, else null. */
  readonly question: Question | null;
  /** 1-based position of the current card (answered + 1). Drives pacing. */
  readonly position: number;
  readonly answered: number;
  readonly mode: number;
  readonly profile: Profile;
}

export class SessionError extends Error {
  override name = "SessionError";
}

/** Packs enabled by default: `default: true` and not opt-in. */
export function defaultPacks(bank: Bank): string[] {
  return Object.entries(bank.packs)
    .filter(([, def]) => def.default && !def.opt_in)
    .map(([name]) => name)
    .sort();
}

export function createSession(bank: Bank, config: Partial<SessionConfig> = {}): SessionState {
  const packs = [...new Set(config.packs ?? defaultPacks(bank))].sort();
  for (const p of packs) {
    if (!(p in bank.packs)) throw new SessionError(`Unknown pack "${p}".`);
  }
  const mode = config.mode ?? 20;
  const length = config.length ?? 50;
  if (!Number.isInteger(mode) || mode < 1) throw new SessionError(`Invalid mode ${mode}.`);
  if (!Number.isInteger(length) || length < 1) throw new SessionError(`Invalid length ${length}.`);
  return { config: { mode, length, packs, ai: config.ai ?? false }, answer_log: [], seed_salt: 0 };
}

/** Throws if the log references unknown questions, repeats one, or has an invalid choice. */
export function validateLog(bank: Bank, log: readonly AnswerEvent[]): void {
  const { byId } = bankIndex(bank);
  const seen = new Set<string>();
  for (const e of log) {
    if (!byId.has(e.id)) throw new SessionError(`Unknown question "${e.id}".`);
    if (seen.has(e.id)) throw new SessionError(`Question "${e.id}" answered twice.`);
    if (!["a", "b", "both", "skip"].includes(e.choice)) {
      throw new SessionError(`Invalid choice "${String(e.choice)}" for "${e.id}".`);
    }
    seen.add(e.id);
  }
}

export function viewSession(bank: Bank, state: SessionState): SessionView {
  const profile = foldProfile(bank, state.answer_log);
  const answered = profile.answered;
  const mode = state.config.mode;
  const position = answered + 1;
  const base = { position, answered, mode, profile };
  if (answered >= mode) return { ...base, status: "profile_ready", question: null };
  const question = nextQuestion(
    bank,
    profile,
    state.answer_log,
    new Set(state.config.packs),
    position,
  );
  return question
    ? { ...base, status: "asking", question }
    : { ...base, status: "exhausted", question: null };
}

/** Pure reducer: (state, action) → state. Invalid transitions throw SessionError. */
export function reduceSession(
  bank: Bank,
  state: SessionState,
  action: SessionAction,
): SessionState {
  switch (action.type) {
    case "answer": {
      const view = viewSession(bank, state);
      if (view.status !== "asking" || !view.question) {
        throw new SessionError(`Cannot answer: session is ${view.status}.`);
      }
      if (action.id !== undefined && action.id !== view.question.id) {
        throw new SessionError(
          `Stale answer: current question is "${view.question.id}", not "${action.id}".`,
        );
      }
      return {
        ...state,
        answer_log: [...state.answer_log, { id: view.question.id, choice: action.choice }],
      };
    }
    case "back":
      return state.answer_log.length === 0
        ? state
        : { ...state, answer_log: state.answer_log.slice(0, -1) };
    case "ten_more": {
      const status = viewSession(bank, state).status;
      if (status === "asking") throw new SessionError("Cannot add 10 more while still asking.");
      return { ...state, config: { ...state.config, mode: state.config.mode + MORE_STEP } };
    }
    case "reshuffle":
      return { ...state, seed_salt: state.seed_salt + 1 };
  }
}

/** The playlist seed for a session (HANDOFF §9.5). */
export function sessionSeed(bank: Bank, state: SessionState, catalogVersion: string): string {
  return computeSeed({
    answer_log: state.answer_log,
    mode: state.config.mode,
    length: state.config.length,
    packs: state.config.packs,
    catalog_version: catalogVersion,
    engine_version: engineVersion(bank),
    seed_salt: state.seed_salt,
  });
}
