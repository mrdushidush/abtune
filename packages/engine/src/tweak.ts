import {
  quantizeDistribution,
  TARGET_SCALE,
  type TasteVector,
  validateTaste,
  WEIGHT_SCALE,
} from "./taste.ts";
import type { Dimensions } from "./types.ts";

/**
 * Tweaks (HANDOFF §4.3, "more energy"): preset nudges applied to the taste vector before
 * generation. The result is again a TasteVector, so it's what gets shared and exported, and a
 * shared playlist reproduces without knowing which tweaks made it.
 */
export type TweakAxis = "energy" | "mood" | "popularity" | "era";
export const TWEAK_AXES: readonly TweakAxis[] = ["energy", "mood", "popularity", "era"];

/** Net steps per axis, each in [-MAX_TWEAK_STEPS, MAX_TWEAK_STEPS]; missing = 0. */
export type TweakSteps = Readonly<Partial<Record<TweakAxis, number>>>;
export const MAX_TWEAK_STEPS = 2;

/** The UI's buttons: one per axis and direction. */
export const TWEAKS = {
  more_energy: { axis: "energy", step: 1 },
  calmer: { axis: "energy", step: -1 },
  happier: { axis: "mood", step: 1 },
  moodier: { axis: "mood", step: -1 },
  more_hits: { axis: "popularity", step: 1 },
  deeper_cuts: { axis: "popularity", step: -1 },
  newer: { axis: "era", step: 1 },
  older: { axis: "era", step: -1 },
} as const satisfies Record<string, { axis: TweakAxis; step: 1 | -1 }>;
export type TweakId = keyof typeof TWEAKS;
export const TWEAK_IDS = Object.keys(TWEAKS) as TweakId[];

/** Per step: target shift on each scalar (×1). The first dim is the axis's own; its κ goes to 1. */
const SCALAR_STEPS: Readonly<Record<Exclude<TweakAxis, "era">, Readonly<Record<string, number>>>> =
  {
    energy: { energy: 0.5, tempo: 0.2, dance: 0.15 },
    mood: { valence: 0.5 },
    popularity: { mainstream: 0.5 },
  };
/**
 * Per step, scalars outside a tweaked axis keep this share of their κ. One scalar is ~1/9 of the
 * scalar score, so without this focus a tweak barely moves the playlist (measured in M4).
 */
const TWEAK_FOCUS = 0.6;
/** Era, with decade evidence: share of each decade's mass moved one decade per step. */
const ERA_SHIFT = 0.4;
/** Era, without decade evidence: log-weight difference between neighboring decades per step. */
const ERA_RAMP = 0.35;

/** `steps` after pressing `id`, clamped to ±MAX_TWEAK_STEPS; an axis back at 0 is dropped. */
export function addTweak(steps: TweakSteps, id: TweakId): TweakSteps {
  const { axis, step } = TWEAKS[id];
  const next = Math.max(-MAX_TWEAK_STEPS, Math.min(MAX_TWEAK_STEPS, (steps[axis] ?? 0) + step));
  const out: Partial<Record<TweakAxis, number>> = { ...steps };
  if (next === 0) delete out[axis];
  else out[axis] = next;
  return out;
}

/** Throws unless every value is an integer in range and every key a known axis (e.g. from JSON). */
export function validateTweaks(steps: TweakSteps): void {
  for (const [axis, n] of Object.entries(steps)) {
    if (!(TWEAK_AXES as readonly string[]).includes(axis))
      throw new Error(`tweak: bad axis ${axis}`);
    if (!Number.isInteger(n) || Math.abs(n as number) > MAX_TWEAK_STEPS)
      throw new Error(`tweak: bad steps ${String(n)} for ${axis}`);
  }
}

const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);
const roundInt = (x: number) => {
  const r = Math.round(x);
  return r === 0 ? 0 : r;
};

/** Move `s` of each decade's mass one decade later (dir 1) or earlier (dir −1). Mass is kept. */
function shiftMass(p: readonly number[], dir: 1 | -1, s: number): number[] {
  const out = p.map((x) => x * (1 - s));
  p.forEach((x, i) => {
    const j = i + dir;
    if (j >= 0 && j < p.length) out[j] = (out[j] as number) + x * s;
    else out[i] = (out[i] as number) + x * s; // the end decade has nowhere to go
  });
  return out;
}

function tweakDecades(decades: readonly number[] | null, n: number, steps: number): number[] {
  const dir = steps > 0 ? 1 : -1;
  let p: number[];
  if (decades) {
    p = [...decades];
    for (let k = 0; k < Math.abs(steps); k++) p = shiftMass(p, dir, ERA_SHIFT);
  } else {
    // No era preference yet: lean the whole range toward one end.
    p = Array.from({ length: n }, (_, i) => Math.exp(steps * ERA_RAMP * (i - (n - 1) / 2)));
  }
  return quantizeDistribution(p);
}

/** Apply tweak steps to a taste vector. Pure; no steps returns an equal vector. */
export function applyTweaks(dims: Dimensions, taste: TasteVector, steps: TweakSteps): TasteVector {
  validateTweaks(steps);
  const target = [...taste.target];
  const weight = [...taste.weight];
  const scalarAxes = TWEAK_AXES.filter(
    (a): a is Exclude<TweakAxis, "era"> => a !== "era" && (steps[a] ?? 0) !== 0,
  );
  // Focus first (other dims lose κ), then shift: a dim another tweak focuses on still gets full κ.
  for (const axis of scalarAxes) {
    const n = Math.abs(steps[axis] ?? 0);
    const own = SCALAR_STEPS[axis];
    dims.scalar.forEach((dim, d) => {
      if (!(dim in own)) weight[d] = roundInt((weight[d] ?? 0) * TWEAK_FOCUS ** n);
    });
  }
  for (const axis of scalarAxes) {
    const n = steps[axis] ?? 0;
    Object.entries(SCALAR_STEPS[axis]).forEach(([dim, delta], k) => {
      const d = dims.scalar.indexOf(dim);
      if (d < 0) return;
      target[d] = roundInt(
        clamp((target[d] ?? 0) + n * delta * TARGET_SCALE, -TARGET_SCALE, TARGET_SCALE),
      );
      if (k === 0) weight[d] = WEIGHT_SCALE;
    });
  }
  const era = steps.era ?? 0;
  const out: TasteVector = {
    ...taste,
    target,
    weight,
    decades: era === 0 ? taste.decades : tweakDecades(taste.decades, dims.decades.length, era),
  };
  validateTaste(dims, out);
  return out;
}
