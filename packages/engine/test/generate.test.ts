import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type Bank,
  buildColumns,
  type CatalogColumns,
  type ColumnRow,
  checkPlaylist,
  coverMass,
  createRng,
  DEFAULT_GENERATOR_PARAMS,
  DEFAULT_TASTE_PARAMS,
  energyCurve,
  foldProfile,
  generate,
  largestRemainder,
  playlistTitle,
  type TasteParams,
  type TasteVector,
  tasteVector,
  topK,
  traits,
  validateTaste,
} from "../src/index.ts";
import { PACKS, q } from "./fixtures.ts";

const DIMS: Bank["dimensions"] = {
  scalar: ["energy", "valence", "acoustic", "tempo", "mainstream"],
  decades: ["dec70", "dec80", "dec90", "dec00"],
  genres: ["rock", "pop", "jazz", "metal", "edm"],
  languages: ["lang_en", "lang_he", "lang_other"],
};

const bank = (questions = [q("x", "core", 50, { energy: 0.8 }, { energy: -0.8 })]): Bank => ({
  version: 1,
  dimensions: DIMS,
  packs: PACKS,
  questions,
});

/** A random but reproducible catalog: `hebrew` Hebrew tracks, a few unclustered / undated ones. */
function synthetic(n: number, { seed = "00000000000000aa", hebrew = 0.05 } = {}): CatalogColumns {
  const rng = createRng(seed);
  const u = () => rng.next() * 2 - 1;
  const rows: ColumnRow[] = [];
  for (let i = 0; i < n; i++) {
    const g1 = DIMS.genres[rng.int(DIMS.genres.length)] as string;
    const g2 = DIMS.genres[rng.int(DIMS.genres.length)] as string;
    const clustered = rng.int(20) !== 0;
    const clusters: Record<string, number> = clustered
      ? g1 === g2
        ? { [g1]: 1 }
        : { [g1]: 0.7, [g2]: 0.3 }
      : {};
    rows.push({
      scalars: Object.fromEntries(DIMS.scalar.map((d) => [d, Math.round(u() * 1000) / 1000])),
      confidence: 0.5 + rng.next() / 2,
      clusters,
      primary: clustered ? g1 : null,
      decade: rng.int(50) === 0 ? null : (DIMS.decades[rng.int(DIMS.decades.length)] as string),
      language:
        rng.next() < hebrew
          ? "lang_he"
          : rng.int(10) === 0
            ? "none"
            : rng.int(5) === 0
              ? "lang_other"
              : "lang_en",
      artist: rng.int(Math.max(1, Math.floor(n / 6))),
      titleKey: rng.int(n * 4),
      year: 1975,
    });
  }
  return buildColumns(DIMS, "test-catalog", rows);
}

const neutral = (over: Partial<TasteVector> = {}): TasteVector => ({
  target: DIMS.scalar.map(() => 0),
  weight: DIMS.scalar.map(() => 0),
  decades: null,
  genres: null,
  languages: null,
  ...over,
});

const SEED = "0123456789abcdef";

/** The brief's starting values (§9.1 K ≈ 3, τ 1, the fold's μ), before eval tuning. */
const BRIEF: TasteParams = {
  confidenceRamp: 3,
  tau: { decades: 1, genres: 1, languages: 1 },
  target: "mu",
  popularityLean: { weight: 0.3, target: 0.6 },
};

describe("tasteVector", () => {
  it("no answers: only the popularity lean has weight; groups have no preference", () => {
    const t = tasteVector(bank(), foldProfile(bank(), []), BRIEF);
    // lean 0.3 toward 0.6: κ = 0.3/3, μ = 0.3·0.6 / (1 + 0.3)
    expect(t.weight).toEqual([0, 0, 0, 0, 10]);
    expect(t.target).toEqual([0, 0, 0, 0, 14]);
    expect([t.decades, t.genres, t.languages]).toEqual([null, null, null]);
    // Tuned defaults: lean 0.6 toward 0.6, K = 5, target = evidence mean.
    const d = tasteVector(bank(), foldProfile(bank(), []));
    expect([d.weight[4], d.target[4]]).toEqual([12, 60]);
  });

  it("one answer: κ = 1/K, μ shrunk by the prior unless target = evidence", () => {
    const b = bank();
    const p = foldProfile(b, [{ id: "x", choice: "a" }]);
    expect(tasteVector(b, p, BRIEF).target[0]).toBe(40); // 0.8 / 2
    expect(tasteVector(b, p, BRIEF).weight[0]).toBe(33);
    expect(tasteVector(b, p, { ...BRIEF, target: "evidence" }).target[0]).toBe(80);
    expect(tasteVector(b, p).weight[0]).toBe(20); // K = 5
  });

  it("groups become distributions × 1000 once they have evidence", () => {
    const b = bank([q("g", "core", 50, { rock: 1, dec80: 1 }, { pop: 1 })]);
    const t = tasteVector(b, foldProfile(b, [{ id: "g", choice: "a" }]));
    expect(t.genres?.length).toBe(5);
    expect(t.genres?.[0]).toBeGreaterThan(t.genres?.[1] ?? 0);
    expect(t.decades?.[1]).toBeGreaterThan(t.decades?.[0] ?? 0);
    expect(t.languages).toBeNull();
    expect(() => validateTaste(DIMS, t)).not.toThrow();
  });

  it("validateTaste rejects malformed vectors", () => {
    expect(() => validateTaste(DIMS, neutral({ target: [0, 0, 0, 0] }))).toThrow();
    expect(() => validateTaste(DIMS, neutral({ weight: [0, 0, 0, 0, 101] }))).toThrow();
    expect(() => validateTaste(DIMS, neutral({ genres: [0, 0, 0, 0, 0] }))).toThrow();
    expect(() => validateTaste(DIMS, neutral({ target: [0.5, 0, 0, 0, 0] }))).toThrow();
  });
});

describe("cells and allocation", () => {
  it("largestRemainder splits by weight, remainders to the largest fractions", () => {
    expect(largestRemainder([0.5, 0.3, 0.2], 10)).toEqual([5, 3, 2]);
    expect(largestRemainder([0.34, 0.33, 0.33], 10)).toEqual([4, 3, 3]);
    expect(largestRemainder([0, 0], 3)).toEqual([2, 1]);
  });

  it("coverMass keeps the heaviest keys up to the mass, ties by index", () => {
    expect([...coverMass([100, 600, 300], 0.95)]).toEqual([1, 1, 1, 0]);
    expect([...coverMass([100, 600, 300], 0.9)]).toEqual([0, 1, 1, 0]);
    expect([...coverMass([50, 600, 350], 0.9)]).toEqual([0, 1, 1, 0]);
    expect([...coverMass([500, 500, 0], 0.4)]).toEqual([1, 0, 0, 0]);
  });

  it("topK matches a full sort (score desc, offset asc)", () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 5 }), { maxLength: 60 }),
        fc.nat(70),
        (xs, k) => {
          const scores = Int32Array.from(xs);
          const expected = xs
            .map((_, i) => i)
            .sort((a, b) => (xs[b] as number) - (xs[a] as number) || a - b)
            .slice(0, k);
          expect(topK(scores, 0, xs.length, k)).toEqual(expected);
        },
      ),
    );
  });
});

describe("generate", () => {
  const cat = synthetic(3000);

  it("is a pure function of its inputs", () => {
    const taste = neutral({ weight: [100, 50, 0, 0, 10], target: [80, -20, 0, 0, 14] });
    const a = generate(cat, taste, { length: 50, seed: SEED });
    const b = generate(cat, taste, { length: 50, seed: SEED });
    expect(b).toEqual(a);
    const c = generate(cat, taste, { length: 50, seed: "fedcba9876543210" });
    expect(c.tracks.map((t) => t.index)).not.toEqual(a.tracks.map((t) => t.index));
  });

  it("satisfies §9.3 for random tastes, lengths and seeds", () => {
    const vec = (len: number, lo: number, hi: number) =>
      fc.array(fc.integer({ min: lo, max: hi }), { minLength: len, maxLength: len });
    const dist = (len: number) =>
      fc.option(
        vec(len, 0, 1000).filter((p) => p.some((x) => x > 0)),
        { nil: null },
      );
    fc.assert(
      fc.property(
        vec(5, -100, 100),
        vec(5, 0, 100),
        dist(4),
        dist(5),
        dist(3),
        fc.integer({ min: 1, max: 100 }),
        fc.stringMatching(/^[0-9a-f]{16}$/),
        (target, weight, decades, genres, languages, length, seed) => {
          const taste = { target, weight, decades, genres, languages };
          const out = generate(cat, taste, { length, seed });
          expect(out.warnings).not.toContain("catalog_exhausted");
          expect(
            checkPlaylist(
              cat,
              out.tracks.map((t) => t.index),
              length,
            ),
          ).toEqual([]);
        },
      ),
      { numRuns: 150 },
    );
  });

  it("follows the genre and decade preference", () => {
    const taste = neutral({ genres: [0, 0, 0, 1000, 0], decades: [0, 1000, 0, 0] });
    const out = generate(cat, taste, { length: 30, seed: SEED });
    expect(out.warnings).toEqual([]);
    expect(out.cells).toHaveLength(1);
    expect(out.tracks.every((t) => t.genre === "metal" && t.decade === "dec80")).toBe(true);
  });

  it("applies the language hard filter at p ≥ 0.8 and relaxes it when it can't fill", () => {
    const taste = neutral({ languages: [100, 850, 50] });
    const hebrew = (out: ReturnType<typeof generate>) =>
      out.tracks.filter((t) => cat.lang[t.index] === 1).length;
    const short = generate(cat, taste, { length: 25, seed: SEED });
    expect(hebrew(short)).toBe(25);
    const long = generate(cat, taste, { length: 100, seed: SEED }); // ~150 Hebrew tracks, capped artists
    expect(long.tracks).toHaveLength(100);
    expect(hebrew(long)).toBeGreaterThan(50);
    expect(
      checkPlaylist(
        cat,
        long.tracks.map((t) => t.index),
        100,
      ),
    ).toEqual([]);
  });

  it("warns and returns fewer tracks when the catalog can't fill the playlist", () => {
    const tiny = synthetic(12, { seed: "00000000000000bb" });
    const out = generate(tiny, neutral(), { length: 40, seed: SEED });
    expect(out.warnings).toContain("catalog_exhausted");
    expect(out.tracks.length).toBeLessThan(40);
    const violations = checkPlaylist(
      tiny,
      out.tracks.map((t) => t.index),
      40,
    );
    expect(violations.map((v) => v.rule)).toEqual(["length"]);
  });

  it("rejects bad lengths and mismatched taste vectors", () => {
    expect(() => generate(cat, neutral(), { length: 0, seed: SEED })).toThrow();
    expect(() => generate(cat, neutral({ genres: [1, 2] }), { length: 5, seed: SEED })).toThrow();
  });

  it("sequences along the energy curve: starts mid, peaks around 65%, cools down", () => {
    const out = generate(cat, neutral(), { length: 60, seed: SEED });
    const e = out.tracks.map((t) => cat.scalars[0]?.[t.index] as number);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    const start = mean(e.slice(0, 6));
    const peak = mean(e.slice(33, 45));
    const end = mean(e.slice(54));
    expect(peak).toBeGreaterThan(start);
    expect(peak).toBeGreaterThan(end);
    expect(energyCurve(0)).toBe(0.5);
    expect(energyCurve(0.65)).toBe(1);
    expect(energyCurve(1)).toBeCloseTo(0.3);
  });
});

describe("archetypes and titles", () => {
  it("maps the four traits to the §9.6 table", () => {
    const t = neutral({
      target: [50, -50, -30, 0, 0],
      decades: [800, 200, 0, 0],
      genres: [0, 0, 0, 0, 1000],
    });
    expect(traits(DIMS, t)).toEqual({
      energy: "hi",
      mood: "dark",
      era: "retro",
      texture: "electric",
    });
    const title = playlistTitle(DIMS, t, 50, "9f3a000000000000");
    expect(title.archetype).toBe("Midnight Synth Rider");
    expect(title.title).toBe("Midnight Synth Rider · EDM 70s");
    expect(title.description).toBe("50 answers · seed 9f3a…");
  });

  it("defaults: no decade evidence is modern, zero targets are hi/bright/organic", () => {
    const title = playlistTitle(DIMS, neutral(), 10, "0000000000000000");
    expect(title.archetype).toBe("Festival Wanderer");
    expect(title.title).toBe("Festival Wanderer");
  });
});

describe("generator defaults", () => {
  it("are the brief's §9.1 weights with the eval-tuned language weight", () => {
    const p = DEFAULT_GENERATOR_PARAMS;
    expect([p.wScalar, p.wGenre, p.wDecade, p.wLanguage]).toEqual([0.45, 0.3, 0.15, 0.2]);
    expect(DEFAULT_TASTE_PARAMS.tau.genres).toBe(0.25);
  });
});
