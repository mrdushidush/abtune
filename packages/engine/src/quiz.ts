import type { SelectOptions } from "./select.ts";
import {
  createSession,
  reduceSession,
  type SessionConfig,
  type SessionState,
  type SessionView,
  viewSession,
} from "./session.ts";
import type { Bank, Choice, Question } from "./types.ts";

/** Answers one card (bots, simulations, the eval's personas). */
export type Answerer = (question: Question) => Choice;

export interface QuizRun {
  readonly state: SessionState;
  readonly view: SessionView;
  /** Every question asked, in order (skips included). */
  readonly sequence: readonly string[];
}

/** Answer questions until the session stops asking. */
export function runQuiz(
  bank: Bank,
  config: Partial<SessionConfig>,
  answer: Answerer,
  options: SelectOptions = {},
): QuizRun {
  let state = createSession(bank, config);
  const sequence: string[] = [];
  let view = viewSession(bank, state, options);
  while (view.status === "asking" && view.question) {
    sequence.push(view.question.id);
    state = reduceSession(bank, state, { type: "answer", choice: answer(view.question) }, options);
    view = viewSession(bank, state, options);
  }
  return { state, view, sequence };
}
