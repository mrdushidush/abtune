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

/** Retro means a decade-weighted mean year before this. */
export const RETRO_BEFORE = 2000;

function scalarTarget(dims: Dimensions, taste: TasteVector, dim: string): number {
  const i = dims.scalar.indexOf(dim);
  return i < 0 ? 0 : (taste.target[i] ?? 0);
}

/**
 * Decade-weighted mean year (decade midpoints), or null without decade evidence.
 * Midpoint of dec50 is 1955 even though it stands for "≤1959".
 */
export function meanYear(dims: Dimensions, taste: TasteVector): number | null {
  const p = taste.decades;
  if (!p) return null;
  let sum = 0;
  let total = 0;
  dims.decades.forEach((key, i) => {
    const start = decadeStart(key);
    const w = p[i] ?? 0;
    if (start === null || w === 0) return;
    sum += w * (start + 5);
    total += w;
  });
  return total > 0 ? sum / total : null;
}

/** HANDOFF §9.6. Without decade evidence the era is "modern" (the catalog's mean year is ~2006). */
export function traits(dims: Dimensions, taste: TasteVector): Traits {
  const year = meanYear(dims, taste);
  return {
    energy: scalarTarget(dims, taste, "energy") >= 0 ? "hi" : "lo",
    mood: scalarTarget(dims, taste, "valence") >= 0 ? "bright" : "dark",
    era: year !== null && year < RETRO_BEFORE ? "retro" : "modern",
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
