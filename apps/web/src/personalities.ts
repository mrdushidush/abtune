// The 16 music personalities as pages (/types/<slug>): shared by the server's routes, the build that
// writes the pages, and the tests.
import { archetypeName, type Traits } from "@abtune/engine";

export interface Personality {
  /** "hi.bright.retro.organic": the traits in archetype.ts's key order. */
  readonly key: string;
  readonly traits: Traits;
  readonly name: string;
  /** The page's address under /types: "sunburst-revivalist". */
  readonly slug: string;
}

/** Where the pages live: `/types` lists them, `/types/<slug>` is one. */
export const TYPES_PATH = "types";

export const traitKey = (t: Traits): string => `${t.energy}.${t.mood}.${t.era}.${t.texture}`;

/** "Bass-Drop Outlaw" → "bass-drop-outlaw". */
export const slugOf = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");

const ENERGY = ["hi", "lo"] as const;
const MOOD = ["bright", "dark"] as const;
const ERA = ["retro", "modern"] as const;
const TEXTURE = ["organic", "electric"] as const;

/** HANDOFF §9.6's order: rows Energy·Mood, columns Era·Texture. */
export const PERSONALITIES: readonly Personality[] = ENERGY.flatMap((energy) =>
  MOOD.flatMap((mood) =>
    ERA.flatMap((era) =>
      TEXTURE.map((texture) => {
        const traits: Traits = { energy, mood, era, texture };
        const name = archetypeName(traits);
        return { key: traitKey(traits), traits, name, slug: slugOf(name) };
      }),
    ),
  ),
);

/** The four types one trait away, in trait order (energy, mood, era, texture). */
export function neighbors(p: Personality): readonly { trait: keyof Traits; to: Personality }[] {
  const flip = {
    energy: { hi: "lo", lo: "hi" },
    mood: { bright: "dark", dark: "bright" },
    era: { retro: "modern", modern: "retro" },
    texture: { organic: "electric", electric: "organic" },
  } as const;
  return (Object.keys(flip) as (keyof Traits)[]).map((trait) => {
    const traits = {
      ...p.traits,
      [trait]: (flip[trait] as Record<string, string>)[p.traits[trait]],
    };
    const to = PERSONALITIES.find((q) => q.key === traitKey(traits as Traits));
    if (!to) throw new Error(`no personality for ${traitKey(traits as Traits)}`);
    return { trait, to };
  });
}
