import {
  type Bank,
  type CatalogColumns,
  type Choice,
  checkPlaylist,
  createRng,
  DEFAULT_GENERATOR_PARAMS,
  DEFAULT_TASTE_PARAMS,
  defaultPacks,
  type GenerateWarning,
  type GeneratorParams,
  generate,
  LENGTHS,
  MODES,
  runQuiz,
  type SelectOptions,
  type SessionState,
  type SessionView,
  sessionSeed,
  sha256Hex,
  type TasteParams,
  tasteVector,
} from "@abtune/engine";
import { personaAnswerer } from "./answerer.ts";
import { fitTables, type PlaylistMetrics, playlistMetrics, type Recognition } from "./metrics.ts";
import type { Persona } from "./persona.ts";

export interface EvalSettings {
  readonly modes: readonly number[];
  /** Playlists per (persona, mode): seed_salt 0 … salts − 1 (reshuffles). */
  readonly salts: number;
  readonly length: number;
  /** Share of persona answers flipped (0 = the deterministic bot of HANDOFF §17). */
  readonly noise: number;
  readonly taste: TasteParams;
  readonly generator: GeneratorParams;
  readonly select: SelectOptions;
}

/**
 * HANDOFF §16 #5: the recorded minimum of fit(100 q) − fit(10 q) on the full catalog. Set at 0.35 in
 * M3; re-recorded at 0.30 on 2026-10-03 for hit-first playlists (owner decision D1: recognition over fit).
 */
export const FIT_MARGIN = 0.3;

/**
 * Owner decision D1 (2026-10-03): recognition is guarded like fit. Recorded minimums over every
 * persona playlist on the full catalog: canon hits per 100 tracks, and the share of signature songs.
 */
export const CANON_MIN = 7;
export const SIG_MIN = 0.65;

export const DEFAULT_EVAL: EvalSettings = {
  modes: MODES,
  salts: 5,
  length: 50,
  noise: 0,
  taste: DEFAULT_TASTE_PARAMS,
  generator: DEFAULT_GENERATOR_PARAMS,
  select: {},
};

export interface PersonaQuiz {
  readonly persona: Persona;
  readonly mode: number;
  readonly state: SessionState;
  readonly view: SessionView;
}

export interface PlaylistRun {
  readonly salt: number;
  readonly seed: string;
  readonly tracks: readonly number[];
  readonly metrics: PlaylistMetrics;
  readonly violations: number;
  readonly warnings: readonly GenerateWarning[];
}

export interface PersonaModeResult {
  readonly persona: Persona;
  readonly mode: number;
  readonly answered: number;
  readonly exhausted: boolean;
  readonly playlists: readonly PlaylistRun[];
  /** Mean over the playlists. */
  readonly metrics: PlaylistMetrics;
}

/** Each persona answers each mode's quiz (a longer mode extends the shorter one's answers). */
export function runPersonaQuizzes(
  bank: Bank,
  personas: readonly Persona[],
  settings: Pick<EvalSettings, "modes" | "length" | "noise" | "select">,
): PersonaQuiz[] {
  const out: PersonaQuiz[] = [];
  for (const persona of personas) {
    for (const mode of settings.modes) {
      const rng = createRng(
        sha256Hex(`persona:${persona.id}:noise:${settings.noise}`).slice(0, 16),
      );
      const answer = personaAnswerer(bank, persona, settings.noise, rng);
      const run = runQuiz(
        bank,
        { mode, length: settings.length, packs: defaultPacks(bank) },
        answer,
        settings.select,
      );
      out.push({ persona, mode, state: run.state, view: run.view });
    }
  }
  return out;
}

const METRIC_KEYS = [
  "cluster",
  "decade",
  "language",
  "scalar",
  "fit",
  "fit2",
  "diversity",
  "artistSpread",
  "popularity",
  "year",
  "hits",
  "sig",
  "canon",
  "hebrew",
] as const satisfies readonly (keyof PlaylistMetrics)[];

function meanMetrics(ms: readonly PlaylistMetrics[]): PlaylistMetrics {
  const out = {} as Record<keyof PlaylistMetrics, number>;
  for (const k of METRIC_KEYS)
    out[k] = ms.length ? ms.reduce((a, m) => a + m[k], 0) / ms.length : 0;
  return out;
}

/** Generate and score every (persona, mode) × salt playlist. */
export function evaluateQuizzes(
  bank: Bank,
  columns: CatalogColumns,
  quizzes: readonly PersonaQuiz[],
  settings: EvalSettings,
  recog?: Recognition,
): PersonaModeResult[] {
  const tables = new Map<string, ReturnType<typeof fitTables>>();
  return quizzes.map(({ persona, mode, state, view }) => {
    let t = tables.get(persona.id);
    if (!t) {
      t = fitTables(columns, persona);
      tables.set(persona.id, t);
    }
    const taste = tasteVector(bank, view.profile, settings.taste);
    const playlists: PlaylistRun[] = [];
    for (let salt = 0; salt < settings.salts; salt++) {
      const seed = sessionSeed(bank, { ...state, seed_salt: salt }, columns.version);
      const out = generate(columns, taste, {
        length: settings.length,
        seed,
        params: settings.generator,
      });
      const tracks = out.tracks.map((x) => x.index);
      playlists.push({
        salt,
        seed,
        tracks,
        metrics: playlistMetrics(columns, t, tracks, recog),
        violations: checkPlaylist(columns, tracks, settings.length, settings.generator).length,
        warnings: out.warnings,
      });
    }
    return {
      persona,
      mode,
      answered: view.answered,
      exhausted: view.status === "exhausted",
      playlists,
      metrics: meanMetrics(playlists.map((p) => p.metrics)),
    };
  });
}

export interface ModeSummary {
  readonly mode: number;
  readonly metrics: PlaylistMetrics;
  readonly violations: number;
  readonly playlists: number;
}

export interface EvalSummary {
  readonly byMode: readonly ModeSummary[];
  /** Mean fit strictly rises with every step up in mode (HANDOFF §16 #5). */
  readonly monotone: boolean;
  /** Mean fit at the deepest mode minus the shallowest. */
  readonly margin: number;
  /** Mean fit over every playlist. */
  readonly meanFit: number;
  /** Over every playlist (owner decision D1): hits-view share, signature share, canon per 100. */
  readonly hits: number;
  readonly sig: number;
  readonly canon: number;
  /** Mean Hebrew share of the Hebrew personas' playlists (ids starting with "hebrew_"). */
  readonly hebrewShare: number;
}

export function summarize(results: readonly PersonaModeResult[]): EvalSummary {
  const modes = [...new Set(results.map((r) => r.mode))].sort((a, b) => a - b);
  const byMode = modes.map((mode) => {
    const rows = results.filter((r) => r.mode === mode);
    return {
      mode,
      metrics: meanMetrics(rows.map((r) => r.metrics)),
      violations: rows.reduce((a, r) => a + r.playlists.reduce((b, p) => b + p.violations, 0), 0),
      playlists: rows.reduce((a, r) => a + r.playlists.length, 0),
    };
  });
  const fits = byMode.map((m) => m.metrics.fit);
  const all = meanMetrics(results.map((r) => r.metrics));
  const he = meanMetrics(
    results.filter((r) => r.persona.id.startsWith("hebrew_")).map((r) => r.metrics),
  );
  return {
    hits: all.hits,
    sig: all.sig,
    canon: all.canon,
    hebrewShare: he.hebrew,
    byMode,
    monotone: fits.every((f, i) => i === 0 || f > (fits[i - 1] as number)),
    margin: fits.length > 1 ? (fits.at(-1) as number) - (fits[0] as number) : 0,
    meanFit: fits.length ? fits.reduce((a, b) => a + b, 0) / fits.length : 0,
  };
}

export interface RandomCheck {
  readonly playlists: number;
  readonly violations: number;
  /** Playlists that came back short with `catalog_exhausted`. */
  readonly short: number;
  /** Generation wall times for 50-track playlists, ms, ascending. */
  readonly ms50: readonly number[];
}

/**
 * HANDOFF §16 #3/#4 on random listeners: random answer logs (a/b/both/skip), random mode and
 * length, each generated and checked against §9.3; 50-track generations are timed.
 */
export function randomPlaylists(
  bank: Bank,
  columns: CatalogColumns,
  count: number,
  masterSeed: string,
  settings: Pick<EvalSettings, "taste" | "generator" | "select">,
): RandomCheck {
  const rng = createRng(masterSeed);
  const choices: Choice[] = ["a", "b", "both", "skip"];
  let violations = 0;
  let short = 0;
  const ms50: number[] = [];
  for (let i = 0; i < count; i++) {
    const mode = MODES[rng.int(MODES.length)] as number;
    const length = i % 4 === 0 ? 50 : (LENGTHS[rng.int(LENGTHS.length)] as number);
    const run = runQuiz(
      bank,
      { mode, length, packs: defaultPacks(bank) },
      () => choices[rng.int(choices.length)] as Choice,
      settings.select,
    );
    const taste = tasteVector(bank, run.view.profile, settings.taste);
    const seed = sessionSeed(bank, run.state, columns.version);
    const t0 = performance.now();
    const out = generate(columns, taste, { length, seed, params: settings.generator });
    const ms = performance.now() - t0;
    if (length === 50) ms50.push(ms);
    const tracks = out.tracks.map((x) => x.index);
    const v = checkPlaylist(columns, tracks, length, settings.generator);
    if (out.warnings.includes("catalog_exhausted")) {
      short++;
      violations += v.filter((x) => x.rule !== "length").length;
    } else {
      violations += v.length;
    }
  }
  return { playlists: count, violations, short, ms50: ms50.sort((a, b) => a - b) };
}

/** q-quantile (nearest rank) of ascending values. */
export function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)] as number;
}
