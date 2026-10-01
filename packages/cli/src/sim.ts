import {
  type Bank,
  type Choice,
  createRng,
  createSession,
  defaultPacks,
  MODES,
  PRIOR_WEIGHT,
  type Profile,
  type Question,
  type Rng,
  reduceSession,
  type SessionConfig,
  type SessionState,
  type SessionView,
  SPICY_PACK,
  sessionSeed,
  viewSession,
} from "@abtune/engine";

export type Answerer = (question: Question) => Choice;

export interface QuizRun {
  readonly state: SessionState;
  readonly view: SessionView;
  /** Every question asked, in order (skips included). */
  readonly sequence: readonly string[];
}

/** Answer questions until the session stops asking. */
export function runQuiz(bank: Bank, config: Partial<SessionConfig>, answer: Answerer): QuizRun {
  let state = createSession(bank, config);
  const sequence: string[] = [];
  let view = viewSession(bank, state);
  while (view.status === "asking" && view.question) {
    sequence.push(view.question.id);
    state = reduceSession(bank, state, { type: "answer", choice: answer(view.question) });
    view = viewSession(bank, state);
  }
  return { state, view, sequence };
}

export const ANSWER_MIXES = {
  ab: ["a", "b"],
  "ab+both": ["a", "b", "both"],
  "ab+both+skip": ["a", "b", "both", "skip"],
} as const satisfies Record<string, readonly Choice[]>;
export type AnswerMix = keyof typeof ANSWER_MIXES;

export function randomAnswerer(rng: Rng, mix: AnswerMix): Answerer {
  const choices = ANSWER_MIXES[mix];
  return () => choices[rng.int(choices.length)] as Choice;
}

/** HANDOFF §16 #6: ≥7 of 9 scalar dims, plus decades and genres, received evidence. */
export function coverageOk(bank: Bank, profile: Profile, minScalars = 7): boolean {
  const touched = bank.dimensions.scalar.filter(
    (d) => (profile.scalars[d]?.c ?? PRIOR_WEIGHT) > PRIOR_WEIGHT,
  ).length;
  return (
    touched >= minScalars &&
    profile.groups.decades.evidence > 0 &&
    profile.groups.genres.evidence > 0
  );
}

export interface SimStats {
  readonly runs: number;
  readonly mode: number;
  readonly mix: AnswerMix;
  readonly exhaustedRate: number;
  readonly minAnswered: number;
  readonly coverageRate: number;
}

/** Random-answer runs from a fixed seed: reproducible statistics for DECISIONS.md. */
export function simulate(
  bank: Bank,
  opts: { runs: number; mode: number; mix: AnswerMix; seed: string; packs?: readonly string[] },
): SimStats {
  const rng = createRng(opts.seed);
  const answer = randomAnswerer(rng, opts.mix);
  let exhausted = 0;
  let covered = 0;
  let minAnswered = Number.POSITIVE_INFINITY;
  for (let i = 0; i < opts.runs; i++) {
    const run = runQuiz(
      bank,
      { mode: opts.mode, ...(opts.packs ? { packs: opts.packs } : {}) },
      answer,
    );
    if (run.view.status === "exhausted") exhausted++;
    if (coverageOk(bank, run.view.profile)) covered++;
    minAnswered = Math.min(minAnswered, run.view.answered);
  }
  return {
    runs: opts.runs,
    mode: opts.mode,
    mix: opts.mix,
    exhaustedRate: exhausted / opts.runs,
    minAnswered,
    coverageRate: covered / opts.runs,
  };
}

/**
 * One randomized session exercising every action (answer/both/skip, back, ten_more,
 * reshuffle), summarized as plain data. Used by the determinism property test.
 */
export function randomSessionTrace(bank: Bank, rng: Rng, catalogVersion: string) {
  const mode = MODES[rng.int(MODES.length)] as number;
  const packs = rng.int(2) === 0 ? defaultPacks(bank) : [...defaultPacks(bank), SPICY_PACK];
  const choices = ANSWER_MIXES["ab+both+skip"];
  let state = createSession(bank, { mode, packs, length: 50 });
  const sequence: string[] = [];
  let view = viewSession(bank, state);
  let moreLeft = rng.int(3);
  for (let guard = 0; guard < 1000; guard++) {
    if (view.status === "asking" && view.question) {
      if (state.answer_log.length > 0 && rng.int(10) === 0) {
        state = reduceSession(bank, state, { type: "back" });
      } else {
        sequence.push(view.question.id);
        const choice = choices[rng.int(choices.length)] as Choice;
        state = reduceSession(bank, state, { type: "answer", choice, id: view.question.id });
      }
    } else if (moreLeft > 0) {
      moreLeft--;
      state = reduceSession(bank, state, { type: "ten_more" });
    } else {
      break;
    }
    view = viewSession(bank, state);
  }
  if (rng.int(2) === 0) state = reduceSession(bank, state, { type: "reshuffle" });
  return {
    config: state.config,
    sequence,
    log: state.answer_log,
    status: view.status,
    answered: view.answered,
    profile: view.profile,
    seed: sessionSeed(bank, state, catalogVersion),
  };
}
