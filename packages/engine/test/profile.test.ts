import { describe, expect, it } from "vitest";
import {
  answerEffects,
  emptyProfile,
  foldProfile,
  groupDistribution,
  topCategories,
} from "../src/index.ts";
import { makeBank, q } from "./fixtures.ts";

const core = q("core_q", "core", 50, { energy: 0.5, rock: 1 }, { energy: -0.5, pop: 1 });
const vibe = q("vibe_q", "vibe", 50, { energy: 1 }, { energy: -1 });
const heavy = q("heavy_q", "core", 50, { valence: 1 }, { valence: -1 }, { weight: 2 });
const mixed = q("mixed_q", "core", 50, { energy: 1, rock: 1 }, { energy: -0.5, pop: 1, dec80: 1 });
const bank = makeBank([core, vibe, heavy, mixed]);

describe("foldProfile (HANDOFF §7.3)", () => {
  it("starts at the prior: μ = 0, C = 1, no categorical evidence", () => {
    const p = foldProfile(bank, []);
    expect(p).toEqual(emptyProfile(bank));
    expect(p.scalars.energy).toEqual({ mu: 0, c: 1 });
    expect(p.groups.genres.evidence).toBe(0);
  });

  it("moves scalars toward the target and adds categorical evidence", () => {
    const p = foldProfile(bank, [{ id: "core_q", choice: "a" }]);
    expect(p.scalars.energy).toEqual({ mu: 0.25, c: 2 }); // (1·0 + 1·0.5) / (1 + 1)
    expect(p.groups.genres.s).toMatchObject({ rock: 1, pop: 0 });
    expect(p.groups.genres.evidence).toBe(1);
    expect(p.answered).toBe(1);
  });

  it("weights by pack weight × question weight", () => {
    const pv = foldProfile(bank, [{ id: "vibe_q", choice: "a" }]);
    expect(pv.scalars.energy?.c).toBeCloseTo(1.4);
    expect(pv.scalars.energy?.mu).toBeCloseTo(0.4 / 1.4);
    const ph = foldProfile(bank, [{ id: "heavy_q", choice: "b" }]);
    expect(ph.scalars.valence).toEqual({ mu: -2 / 3, c: 3 });
  });

  it("applies Both as half weight on the element-wise average", () => {
    const effects = answerEffects(mixed, "both");
    expect(effects).toEqual({ fx: { energy: 0.25, rock: 0.5, pop: 0.5, dec80: 0.5 }, mult: 0.5 });
    const p = foldProfile(bank, [{ id: "mixed_q", choice: "both" }]);
    expect(p.scalars.energy?.mu).toBeCloseTo((0.5 * 0.25) / 1.5);
    expect(p.scalars.energy?.c).toBe(1.5);
    expect(p.groups.genres.s).toMatchObject({ rock: 0.25, pop: 0.25 });
    expect(p.groups.decades.evidence).toBe(0.25);
  });

  it("ignores skips", () => {
    const p = foldProfile(bank, [{ id: "core_q", choice: "skip" }]);
    expect(p).toEqual(emptyProfile(bank));
  });

  it("rejects unknown question ids", () => {
    expect(() => foldProfile(bank, [{ id: "nope", choice: "a" }])).toThrow(/unknown question/);
  });
});

describe("group helpers", () => {
  it("ranks top categories by score, ties in declaration order, positives only", () => {
    const tie = makeBank([q("t1", "core", 50, { pop: 1, jazz: 1, metal: -1 }, { rock: 0.5 })]);
    const p = foldProfile(tie, [{ id: "t1", choice: "a" }]);
    expect(topCategories(tie, p, "genres", 3)).toEqual(["pop", "jazz"]);
  });

  it("has no distribution without evidence, and a normalized one with it", () => {
    expect(groupDistribution(bank, foldProfile(bank, []), "genres", 1)).toBeNull();
    const dist = groupDistribution(
      bank,
      foldProfile(bank, [{ id: "core_q", choice: "a" }]),
      "genres",
      1,
    );
    expect(dist).not.toBeNull();
    const values = Object.values(dist ?? {});
    expect(values.reduce((x, y) => x + y, 0)).toBeCloseTo(1);
    expect(dist?.rock).toBeGreaterThan(dist?.pop ?? 1);
  });

  it("relativeTau keeps a deep profile's split scale-invariant; shallow profiles keep τ", () => {
    const withScores = (rock: number, pop: number) => {
      const p = emptyProfile(bank);
      const genres = { s: { ...p.groups.genres.s, rock, pop }, evidence: rock + pop };
      return { ...p, groups: { ...p.groups, genres } };
    };
    const split = (rock: number, pop: number, rel: number) =>
      groupDistribution(bank, withScores(rock, pop), "genres", 0.25, rel)?.rock ?? 0;
    // A fixed τ sharpens as the same 5:4 ratio accumulates; the relative one doesn't.
    expect(split(5, 4, 0)).toBeGreaterThan(0.97);
    expect(split(10, 8, 0)).toBeGreaterThan(0.999);
    expect(split(5, 4, 0.15)).toBeCloseTo(split(10, 8, 0.15), 10);
    expect(split(5, 4, 0.15)).toBeGreaterThan(0.5);
    expect(split(5, 4, 0.15)).toBeLessThan(0.8);
    // Below τ / relativeTau the plain τ applies.
    expect(split(1, 0.5, 0.15)).toBe(split(1, 0.5, 0));
  });
});
