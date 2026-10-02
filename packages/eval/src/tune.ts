import { type Bank, type CatalogColumns, DEFAULT_IG_NORM, type IgNorm } from "@abtune/engine";
import type { Persona } from "./persona.ts";
import {
  type EvalSettings,
  type EvalSummary,
  evaluateQuizzes,
  type PersonaQuiz,
  runPersonaQuizzes,
  summarize,
} from "./run.ts";

/** One tunable constant: candidate values, and how to read / set it on the settings. */
export interface TuneDim {
  readonly name: string;
  readonly values: readonly (number | string)[];
  get(s: EvalSettings): number | string;
  set(s: EvalSettings, v: number | string): EvalSettings;
}

const taste = (s: EvalSettings, patch: Partial<EvalSettings["taste"]>): EvalSettings => ({
  ...s,
  taste: { ...s.taste, ...patch },
});
const gen = (s: EvalSettings, patch: Partial<EvalSettings["generator"]>): EvalSettings => ({
  ...s,
  generator: { ...s.generator, ...patch },
});

/**
 * What the persona eval tunes. Temperature and the MMR penalty only trade relevance for variety,
 * so they stay at the brief's values instead of being driven to "no variety" by the fit metric.
 */
export const TUNE_SPACE: readonly TuneDim[] = [
  {
    name: "select.igNorm",
    values: ["none", "sqrt", "keys"],
    get: (s) => s.select.igNorm ?? DEFAULT_IG_NORM,
    set: (s, v) => ({ ...s, select: { igNorm: v as IgNorm } }),
  },
  {
    name: "taste.tau.genres",
    values: [0.25, 0.5, 1, 2],
    get: (s) => s.taste.tau.genres,
    set: (s, v) => taste(s, { tau: { ...s.taste.tau, genres: v as number } }),
  },
  {
    name: "taste.tau.decades",
    values: [0.25, 0.5, 1, 2],
    get: (s) => s.taste.tau.decades,
    set: (s, v) => taste(s, { tau: { ...s.taste.tau, decades: v as number } }),
  },
  {
    name: "taste.tau.languages",
    values: [0.25, 0.5, 1],
    get: (s) => s.taste.tau.languages,
    set: (s, v) => taste(s, { tau: { ...s.taste.tau, languages: v as number } }),
  },
  {
    name: "taste.confidenceRamp",
    values: [1, 2, 3, 5],
    get: (s) => s.taste.confidenceRamp,
    set: (s, v) => taste(s, { confidenceRamp: v as number }),
  },
  {
    name: "taste.target",
    values: ["mu", "evidence"],
    get: (s) => s.taste.target,
    set: (s, v) => taste(s, { target: v as "mu" | "evidence" }),
  },
  {
    name: "taste.popularityLean.weight",
    values: [0.3, 0.6, 1],
    get: (s) => s.taste.popularityLean.weight,
    set: (s, v) => taste(s, { popularityLean: { ...s.taste.popularityLean, weight: v as number } }),
  },
  {
    name: "taste.popularityLean.target",
    values: [0.4, 0.6, 0.8],
    get: (s) => s.taste.popularityLean.target,
    set: (s, v) => taste(s, { popularityLean: { ...s.taste.popularityLean, target: v as number } }),
  },
  {
    name: "generator.wScalar",
    values: [0.25, 0.45, 0.65],
    get: (s) => s.generator.wScalar,
    set: (s, v) => gen(s, { wScalar: v as number }),
  },
  {
    name: "generator.wGenre",
    values: [0.15, 0.3, 0.45],
    get: (s) => s.generator.wGenre,
    set: (s, v) => gen(s, { wGenre: v as number }),
  },
  {
    name: "generator.wDecade",
    values: [0.075, 0.15, 0.3],
    get: (s) => s.generator.wDecade,
    set: (s, v) => gen(s, { wDecade: v as number }),
  },
  {
    name: "generator.wLanguage",
    values: [0.05, 0.1, 0.2],
    get: (s) => s.generator.wLanguage,
    set: (s, v) => gen(s, { wLanguage: v as number }),
  },
  {
    name: "generator.languageNeutral",
    values: [0.25, 0.5],
    get: (s) => s.generator.languageNeutral,
    set: (s, v) => gen(s, { languageNeutral: v as number }),
  },
  {
    name: "generator.prefilterMass",
    values: [0.8, 0.9, 0.95],
    get: (s) => s.generator.prefilterMass,
    set: (s, v) => gen(s, { prefilterMass: v as number }),
  },
];

export interface TuneStep {
  readonly dim: string;
  readonly value: number | string;
  readonly summary: EvalSummary;
  readonly objective: number;
  readonly accepted: boolean;
}

export interface TuneResult {
  readonly settings: EvalSettings;
  readonly start: EvalSummary;
  readonly best: EvalSummary;
  readonly steps: readonly TuneStep[];
}

/** Keep variety within this share of the starting settings' diversity. */
export const DIVERSITY_FLOOR = 0.9;

/**
 * Coordinate search: for each dim in turn, try every value with the others fixed and keep the
 * best (ties keep the current value). Objective = mean persona fit over all modes, rejected unless
 * fit rises strictly with depth and diversity stays above DIVERSITY_FLOOR × the start's.
 */
export function tune(
  bank: Bank,
  columns: CatalogColumns,
  personas: readonly Persona[],
  start: EvalSettings,
  { passes = 2, log = (_: string) => {} }: { passes?: number; log?: (line: string) => void } = {},
): TuneResult {
  const quizCache = new Map<string, PersonaQuiz[]>();
  const quizzes = (s: EvalSettings) => {
    const key = JSON.stringify(s.select);
    let q = quizCache.get(key);
    if (!q) {
      q = runPersonaQuizzes(bank, personas, s);
      quizCache.set(key, q);
    }
    return q;
  };
  const run = (s: EvalSettings) => summarize(evaluateQuizzes(bank, columns, quizzes(s), s));

  const first = run(start);
  const diversity = (x: EvalSummary) =>
    x.byMode.reduce((a, m) => a + m.metrics.diversity, 0) / Math.max(1, x.byMode.length);
  const floor = DIVERSITY_FLOOR * diversity(first);
  const objective = (x: EvalSummary) =>
    x.meanFit - (x.monotone ? 0 : 1) - (diversity(x) >= floor ? 0 : 1);

  let current = start;
  let best = first;
  let bestObjective = objective(first);
  const steps: TuneStep[] = [];
  log(
    `start: fit ${first.meanFit.toFixed(4)} margin ${first.margin.toFixed(4)} monotone ${first.monotone}` +
      ` diversity ${diversity(first).toFixed(4)} (floor ${floor.toFixed(4)})`,
  );
  for (let pass = 0; pass < passes; pass++) {
    let changed = false;
    for (const dim of TUNE_SPACE) {
      const was = dim.get(current);
      for (const value of dim.values) {
        if (value === was) continue;
        const candidate = dim.set(current, value);
        const summary = run(candidate);
        const obj = objective(summary);
        const accepted = obj > bestObjective;
        steps.push({ dim: dim.name, value, summary, objective: obj, accepted });
        log(
          `${dim.name}=${value}: fit ${summary.meanFit.toFixed(4)} margin ${summary.margin.toFixed(4)}` +
            ` monotone ${summary.monotone} diversity ${diversity(summary).toFixed(4)}` +
            ` obj ${obj.toFixed(4)}${accepted ? " ✓" : ""}`,
        );
        if (accepted) {
          best = summary;
          bestObjective = obj;
          current = candidate;
          changed = true;
        }
      }
    }
    if (!changed) break;
  }
  return { settings: current, start: first, best, steps };
}
