import { describe, expect, it } from "vitest";
import {
  addTweak,
  applyTweaks,
  type Dimensions,
  type TasteVector,
  TWEAK_IDS,
  type TweakSteps,
  validateTaste,
} from "../src/index.ts";

const DIMS: Dimensions = {
  scalar: ["energy", "valence", "dance", "tempo", "mainstream"],
  decades: ["dec70", "dec80", "dec90", "dec00"],
  genres: ["rock", "pop"],
  languages: ["lang_en", "lang_he"],
};

const base: TasteVector = {
  target: [20, -10, 0, 0, 60],
  weight: [100, 40, 0, 50, 12],
  decades: [100, 700, 200, 0],
  genres: [600, 400],
  languages: null,
};

describe("addTweak", () => {
  it("stacks to ±2 per axis and drops axes back at 0", () => {
    let s: TweakSteps = {};
    s = addTweak(s, "more_energy");
    s = addTweak(s, "more_energy");
    s = addTweak(s, "more_energy");
    expect(s).toEqual({ energy: 2 });
    s = addTweak(s, "newer");
    s = addTweak(s, "calmer");
    s = addTweak(s, "calmer");
    expect(s).toEqual({ era: 1 });
  });
});

describe("applyTweaks", () => {
  it("is the identity without steps", () => {
    expect(applyTweaks(DIMS, base, {})).toEqual(base);
  });

  it("moves targets, focuses κ on the tweaked axis, and clamps", () => {
    const t = applyTweaks(DIMS, base, { energy: 1, popularity: -2 });
    expect(t.target).toEqual([70, -10, 15, 20, -40]);
    // Others keep 0.6 per step of each other axis (valence: 40 × 0.6 × 0.36); own dims get κ 1.
    expect(t.weight).toEqual([100, 9, 0, 18, 100]);
    const up = applyTweaks(DIMS, { ...base, target: [90, 90, 90, 90, 90] }, { energy: 2, mood: 2 });
    expect(up.target).toEqual([100, 100, 100, 100, 90]);
  });

  it("shifts decade mass toward newer or older music", () => {
    const newer = applyTweaks(DIMS, base, { era: 1 });
    expect(newer.decades).toEqual([60, 460, 400, 80]);
    const older = applyTweaks(DIMS, base, { era: -2 });
    expect(older.decades?.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(older.decades?.[0]).toBeGreaterThan(400);
  });

  it("leans the whole range when there is no era preference", () => {
    const t = applyTweaks(DIMS, { ...base, decades: null }, { era: 1 });
    const p = t.decades as number[];
    expect(p.reduce((a, b) => a + b, 0)).toBe(1000);
    expect(p).toEqual([...p].sort((a, b) => a - b));
    expect(p[3]).toBeGreaterThan(p[0] as number);
  });

  it("always yields a valid taste vector", () => {
    for (const id of TWEAK_IDS) {
      let s: TweakSteps = {};
      for (let k = 0; k < 3; k++) {
        s = addTweak(s, id);
        expect(() => validateTaste(DIMS, applyTweaks(DIMS, base, s))).not.toThrow();
      }
    }
  });

  it("rejects bad steps", () => {
    expect(() => applyTweaks(DIMS, base, { energy: 3 })).toThrow(/bad steps/);
    expect(() => applyTweaks(DIMS, base, { volume: 1 } as unknown as TweakSteps)).toThrow(
      /bad axis/,
    );
  });
});
