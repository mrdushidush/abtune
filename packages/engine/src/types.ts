/** One side of a question card. */
export type Side = "a" | "b";

/** Every answer a user can give. `skip` never counts toward the mode. */
export type Choice = Side | "both" | "skip";

export interface QuestionOption {
  readonly label: string;
  readonly emoji: string;
  /** Scalar keys: target position in [-1, 1]. Categorical keys: additive evidence. */
  readonly fx: Readonly<Record<string, number>>;
}

export interface UnlockIf {
  /** `"<question_id>=a|b"`: satisfied if that answer is in the log. */
  readonly any?: readonly string[];
  /** Satisfied if any of these genres is in the current top 3 with s_c > 0. */
  readonly top_genres?: readonly string[];
}

export interface Question {
  readonly id: string;
  readonly pack: string;
  readonly pri: number;
  readonly q?: string;
  /** Defaults to 1 when absent in YAML. */
  readonly weight: number;
  readonly sensitive?: string;
  readonly unlock_if?: UnlockIf;
  readonly a: QuestionOption;
  readonly b: QuestionOption;
}

export interface PackDef {
  readonly weight: number;
  readonly default: boolean;
  readonly opt_in?: boolean;
}

export interface Dimensions {
  readonly scalar: readonly string[];
  readonly decades: readonly string[];
  readonly genres: readonly string[];
  readonly languages: readonly string[];
}

/** A validated, merged question bank (seed + community packs). */
export interface Bank {
  readonly version: number;
  readonly dimensions: Dimensions;
  readonly packs: Readonly<Record<string, PackDef>>;
  readonly questions: readonly Question[];
}

/** Display text for a question: explicit `q`, else "<a.label> or <b.label>?". */
export function questionText(question: Question): string {
  return question.q ?? `${question.a.label} or ${question.b.label}?`;
}
