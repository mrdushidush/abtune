import { clusterLabel, decadeLabel, decadeStart } from "./labels.ts";
import { shortSeed } from "./seed.ts";
import type { TasteVector } from "./taste.ts";
import type { Dimensions } from "./types.ts";

export interface Traits {
  readonly energy: "hi" | "lo";
  readonly mood: "bright" | "dark";
  readonly era: "retro" | "modern";
  readonly texture: "organic" | "electric";
}

/** HANDOFF §9.6: rows Energy·Mood, columns Era·Texture. */
const ARCHETYPES: Readonly<Record<string, string>> = {
  "hi.bright.retro.organic": "Sunburst Revivalist",
  "hi.bright.retro.electric": "Neon Nostalgist",
  "hi.bright.modern.organic": "Festival Wanderer",
  "hi.bright.modern.electric": "Dancefloor Futurist",
  "hi.dark.retro.organic": "Thunder Purist",
  "hi.dark.retro.electric": "Midnight Synth Rider",
  "hi.dark.modern.organic": "Riff Rebel",
  "hi.dark.modern.electric": "Bass-Drop Outlaw",
  "lo.bright.retro.organic": "Porch Poet",
  "lo.bright.retro.electric": "Lounge Lizard",
  "lo.bright.modern.organic": "Coffeehouse Romantic",
  "lo.bright.modern.electric": "Lo-fi Sunbather",
  "lo.dark.retro.organic": "Rainy-Day Balladeer",
  "lo.dark.retro.electric": "Smoky Noir Detective",
  "lo.dark.modern.organic": "Candlelit Confessor",
  "lo.dark.modern.electric": "Night-Drive Ghost",
};

/** Decades starting at or after this year are the era's "modern" side. */
export const RETRO_BEFORE = 2000;

/**
 * Era is Modern when the 2000s–2020s hold at least this share of the decade mass. Every decade keeps
 * a baseline share, which pulled a mean year toward ~1990: a 2010s fan came out Retro. Calibrated
 * (2026-10-04) so a coin-flip answerer lands on either side about equally; see DECISIONS.md.
 */
export const MODERN_SHARE = 0.35;

/**
 * Energy is Hi from this target (TARGET_SCALE units, i.e. +0.15). The bank's cards lean
 * energetic, so a coin-flip answerer's median energy target is +0.12…+0.20; a cut at 0 made Hi
 * three times as common as Lo.
 */
export const ENERGY_HI = 15;

function scalarTarget(dims: Dimensions, taste: TasteVector, dim: string): number {
  const i = dims.scalar.indexOf(dim);
  return i < 0 ? 0 : (taste.target[i] ?? 0);
}

/** Share of the decade mass on decades starting at RETRO_BEFORE or later, or null without evidence. */
export function modernShare(dims: Dimensions, taste: TasteVector): number | null {
  const p = taste.decades;
  if (!p) return null;
  let modern = 0;
  let total = 0;
  dims.decades.forEach((key, i) => {
    const w = p[i] ?? 0;
    total += w;
    if ((decadeStart(key) ?? 0) >= RETRO_BEFORE) modern += w;
  });
  return total > 0 ? modern / total : null;
}

/**
 * HANDOFF §9.6 (cut-offs amended 2026-10-04 so the 16 types spread out). Without decade evidence
 * the era is "modern" (the catalog's mean year is ~2006).
 */
export function traits(dims: Dimensions, taste: TasteVector): Traits {
  const modern = modernShare(dims, taste);
  return {
    energy: scalarTarget(dims, taste, "energy") >= ENERGY_HI ? "hi" : "lo",
    mood: scalarTarget(dims, taste, "valence") >= 0 ? "bright" : "dark",
    era: modern !== null && modern < MODERN_SHARE ? "retro" : "modern",
    texture: scalarTarget(dims, taste, "acoustic") >= 0 ? "organic" : "electric",
  };
}

export function archetypeName(t: Traits): string {
  return ARCHETYPES[`${t.energy}.${t.mood}.${t.era}.${t.texture}`] as string;
}

/** Highest-probability key of a group (ties: declaration order), or null without evidence. */
export function topKey(keys: readonly string[], p: readonly number[] | null): string | null {
  if (!p) return null;
  let best = -1;
  keys.forEach((_, i) => {
    if (best < 0 || (p[i] ?? 0) > (p[best] ?? 0)) best = i;
  });
  return best < 0 ? null : (keys[best] ?? null);
}

export interface PlaylistTitle {
  readonly archetype: string;
  readonly traits: Traits;
  /** "<Archetype> · <top cluster> <top decade>" (parts without evidence are left out). */
  readonly title: string;
  /** "<n> answers · seed 9f3a…" */
  readonly description: string;
}

export function playlistTitle(
  dims: Dimensions,
  taste: TasteVector,
  answered: number,
  seed: string,
): PlaylistTitle {
  const t = traits(dims, taste);
  const name = archetypeName(t);
  const genre = topKey(dims.genres, taste.genres);
  const decade = topKey(dims.decades, taste.decades);
  const tail = [genre && clusterLabel(genre), decade && decadeLabel(decade)].filter(Boolean);
  return {
    archetype: name,
    traits: t,
    title: tail.length > 0 ? `${name} · ${tail.join(" ")}` : name,
    description: `${answered} answers · seed ${shortSeed(seed)}…`,
  };
}
