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
  familiarityRanks,
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

describe("popularity tiers, the familiarity window and pages", () => {
  /** `synthetic`, plus tiers (a share of hits, more deep cuts, the rest long tail) and hit ranks. */
  function tiered(n: number, hits: number, seed = "00000000000000cc"): CatalogColumns {
    const base = synthetic(n, { seed });
    const rng = createRng(seed);
    const tier = new Uint8Array(n);
    const hit = new Float32Array(n);
    const artistRank = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const r = rng.next();
      tier[i] = r < hits ? 0 : r < hits + 0.3 ? 1 : 2;
      hit[i] = rng.next();
      artistRank[i] = 1 + rng.int(10);
    }
    return { ...base, tier, hit, artistRank };
  }
  const POP = DIMS.scalar.indexOf("mainstream");
  const wantPopularity = (t: number) => {
    const target = DIMS.scalar.map(() => 0);
    const weight = DIMS.scalar.map(() => 0);
    target[POP] = Math.round(t * 100);
    weight[POP] = 50;
    return neutral({ target, weight });
  };
  const tiersOf = (cat: CatalogColumns, out: ReturnType<typeof generate>) =>
    new Set(out.tracks.map((t) => cat.tier[t.index] as number));
  const cat = tiered(4000, 0.2);

  it("grades by the popularity target: hits, then deep cuts by known artists, then the long tail", () => {
    const hits = generate(cat, wantPopularity(0.6), { length: 50, seed: SEED });
    expect([...tiersOf(cat, hits)]).toEqual([0]);
    expect(hits.warnings).toEqual([]);
    const deep = generate(cat, wantPopularity(-0.3), { length: 50, seed: SEED });
    expect(Math.max(...tiersOf(cat, deep))).toBe(1);
    const gems = generate(cat, wantPopularity(-0.9), { length: 100, seed: SEED });
    expect(tiersOf(cat, gems).has(2)).toBe(true);
  });

  it("widens tiers before genres when the hits can't fill a playlist", () => {
    const few = tiered(3000, 0.01, "00000000000000dd");
    const taste = { ...wantPopularity(0.6), genres: [0, 1000, 0, 0, 0] };
    const out = generate(few, taste, { length: 40, seed: SEED });
    expect(out.tracks).toHaveLength(40);
    expect(out.warnings).toEqual(["hits_relaxed"]);
    expect(out.tracks.every((t) => t.genre === "pop")).toBe(true);
    // Every hit that fits is used before a deep cut.
    const used = new Set(out.tracks.map((t) => t.index));
    const hitsInCell = out.tracks.filter((t) => few.tier[t.index] === 0).length;
    expect(hitsInCell).toBeGreaterThan(0);
    expect(used.size).toBe(40);
  });

  it("ranks each (cluster, decade, market) group by hit percentile within the allowed tiers", () => {
    const ranks = familiarityRanks(cat, 0);
    for (let i = 0; i < 200; i++) {
      if (cat.tier[i] !== 0) expect(ranks.rank[i]).toBe(-1);
    }
    const group = (i: number) => `${cat.primary[i]}|${cat.decade[i]}|${cat.market[i]}`;
    const byRank = new Map<string, number[]>();
    for (let i = 0; i < cat.n; i++) {
      if (cat.tier[i] !== 0) continue;
      const list = byRank.get(group(i)) ?? [];
      list[ranks.rank[i] as number] = cat.hit[i] as number;
      byRank.set(group(i), list);
    }
    for (const list of byRank.values()) {
      for (let r = 1; r < list.length; r++)
        expect(list[r - 1]).toBeGreaterThanOrEqual(list[r] as number);
    }
  });

  it("continues a playlist: a second page keeps §9.3 over both pages", () => {
    const taste = wantPopularity(0.6);
    const first = generate(cat, taste, { length: 25, seed: SEED }).tracks.map((t) => t.index);
    const second = generate(cat, wantPopularity(0.1), {
      length: 25,
      seed: "fedcba9876543210",
      previous: first,
    }).tracks.map((t) => t.index);
    expect(second).toHaveLength(25);
    expect(checkPlaylist(cat, [...first, ...second], 50)).toEqual([]);
  });

  it("swaps a track for one by an artist new to the playlist", () => {
    const first = generate(cat, wantPopularity(0.6), { length: 25, seed: SEED }).tracks.map(
      (t) => t.index,
    );
    const out = generate(cat, wantPopularity(0.6), {
      length: 1,
      seed: "0000000000000001",
      previous: first,
      newArtistsOnly: true,
    });
    expect(out.tracks).toHaveLength(1);
    const pick = out.tracks[0]?.index as number;
    expect(first).not.toContain(pick);
    expect(first.map((i) => cat.artist[i])).not.toContain(cat.artist[pick]);
  });

  it("backfills a track from its own (primary cluster, decade) cell", () => {
    const first = generate(cat, wantPopularity(0.6), { length: 25, seed: SEED }).tracks.map(
      (t) => t.index,
    );
    const cellOf = (i: number) => `${cat.primary[i]}:${cat.decade[i]}`;
    let found = 0;
    for (const missing of first.slice(0, 5)) {
      const out = generate(cat, wantPopularity(0.6), {
        length: 1,
        seed: "0000000000000002",
        previous: first,
        newArtistsOnly: true,
        sameCellAs: missing,
      });
      for (const t of out.tracks) {
        expect(first).not.toContain(t.index);
        expect(cellOf(t.index)).toBe(cellOf(missing));
        found++;
      }
    }
    expect(found).toBeGreaterThan(0);
    expect(() =>
      generate(cat, wantPopularity(0.6), { length: 1, seed: SEED, sameCellAs: cat.n }),
    ).toThrow(/not a track index/);
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
    expect(DEFAULT_TASTE_PARAMS.relativeTau?.genres).toBe(0.15);
  });
});
