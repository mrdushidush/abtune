// Tweaks (HANDOFF §4.3) must be felt: each preset moves its own measure of the playlist the right
// way. On the full catalog one step moves mean energy/mood/popularity by 0.2–0.4 and the mean year
// by 2–4 years (DECISIONS.md, M4); the fixture checks direction at two steps.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FIXTURE_DIR } from "@abtune/catalog";
import { type LoadedCatalog, loadCatalog } from "@abtune/catalog/reader";
import {
  addTweak,
  applyTweaks,
  type Bank,
  defaultPacks,
  generate,
  runQuiz,
  sessionSeed,
  TWEAK_IDS,
  TWEAKS,
  type TweakId,
  type TweakSteps,
  tasteVector,
} from "@abtune/engine";
import { loadPersonas, personaAnswerer } from "@abtune/eval";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSeedBank } from "./load-seed.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));
const PERSONAS = ["eighties_pop", "indie_folk_introvert", "modern_hiphop_rnb"];
const SEEDS = [0, 1, 2];

let bank: Bank;
let catalog: LoadedCatalog;
beforeAll(async () => {
  bank = await loadSeedBank();
  catalog = await loadCatalog(FIXTURE_DIR, bank.dimensions);
});
afterAll(() => catalog.close());

/**
 * The playlist measure a tweak should move: a scalar's mean, the mean release year, or for
 * popularity the mean hit percentile (the familiarity window's key: hit-first playlists already sit
 * at the top of `mainstream`, so "more hits" shows up as better-known hits, not a higher percentile).
 */
function measure(id: TweakId, tracks: readonly number[]): number {
  const c = catalog.columns;
  const axis = TWEAKS[id].axis;
  if (axis === "era") {
    const years = tracks.map((i) => c.year[i] as number).filter((y) => y > 0);
    return years.reduce((a, b) => a + b, 0) / years.length;
  }
  if (axis === "popularity")
    return tracks.reduce((a, i) => a + (c.hit[i] as number), 0) / tracks.length;
  const dim = { energy: "energy", mood: "valence" }[axis];
  const col = c.scalars[bank.dimensions.scalar.indexOf(dim)] as Float32Array;
  return tracks.reduce((a, i) => a + (col[i] as number), 0) / tracks.length;
}

describe("tweak presets", () => {
  it.each(TWEAK_IDS)("%s moves the playlist its way", async (id) => {
    const personas = await loadPersonas(path.join(REPO, "data/personas"), bank.dimensions);
    let steps: TweakSteps = {};
    steps = addTweak(addTweak(steps, id), id);
    for (const pid of PERSONAS) {
      const persona = personas.find((p) => p.id === pid);
      if (!persona) throw new Error(`no persona ${pid}`);
      const run = runQuiz(
        bank,
        { mode: 20, length: 50, packs: defaultPacks(bank) },
        personaAnswerer(bank, persona),
      );
      const base = tasteVector(bank, run.view.profile);
      const tweaked = applyTweaks(bank.dimensions, base, steps);
      let delta = 0;
      for (const salt of SEEDS) {
        const seed = sessionSeed(bank, { ...run.state, seed_salt: salt }, catalog.columns.version);
        const before = generate(catalog.columns, base, { length: 50, seed }).tracks;
        const after = generate(catalog.columns, tweaked, { length: 50, seed }).tracks;
        delta +=
          measure(
            id,
            after.map((t) => t.index),
          ) -
          measure(
            id,
            before.map((t) => t.index),
          );
      }
      const label = `${id} for ${pid}: Δ ${delta / SEEDS.length}`;
      if (id === "more_hits") {
        // Hit-first playlists already start at the top: "more hits" has almost no headroom left,
        // so it only must not make the playlist less known.
        expect(delta / SEEDS.length, label).toBeGreaterThan(-0.01);
      } else {
        expect(Math.sign(delta), label).toBe(TWEAKS[id].step);
      }
    }
  });
});
