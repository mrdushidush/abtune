import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  AI_MIN_WEIGHT,
  applyAdjust,
  type Bank,
  buildColumns,
  type CatalogColumns,
  type ColumnRow,
  checkPlaylist,
  chooseFromShortlist,
  clampAdjust,
  createRng,
  decodeShare,
  EMPTY_ADJUST,
  encodeShare,
  generate,
  MAX_BLURB_CHARS,
  MAX_GROUP_BOOST,
  MAX_SCALAR_DELTA,
  MAX_SHORTLIST,
  MAX_TITLE_CHARS,
  P_SCALE,
  playlistBase,
  playShortlist,
  type ShareData,
  ShareError,
  shortlistLength,
  type TasteAdjust,
  type TasteVector,
  validateAdjust,
  validateTaste,
} from "../src/index.ts";
import { DIMENSIONS } from "./fixtures.ts";

const taste: TasteVector = {
  target: [55, -100],
  weight: [100, 0],
  decades: [700, 300],
  genres: null,
  languages: [1000, 0],
};

const adjustArb = (dims: Bank["dimensions"]) =>
  fc.record({
    scalar: fc.dictionary(
      fc.constantFrom(...dims.scalar),
      fc.integer({ min: -MAX_SCALAR_DELTA, max: MAX_SCALAR_DELTA }),
    ),
    genres: fc.dictionary(
      fc.constantFrom(...dims.genres),
      fc.integer({ min: -MAX_GROUP_BOOST, max: MAX_GROUP_BOOST }),
    ),
    decades: fc.dictionary(
      fc.constantFrom(...dims.decades),
      fc.integer({ min: -MAX_GROUP_BOOST, max: MAX_GROUP_BOOST }),
    ),
  });

describe("AI adjustments (HANDOFF §10.2 T1/T3)", () => {
  it("an empty adjustment changes nothing", () => {
    expect(applyAdjust(DIMENSIONS, taste, EMPTY_ADJUST)).toEqual(taste);
    expect(playlistBase(DIMENSIONS, taste, undefined)).toBe(taste);
    expect(
      playlistBase(DIMENSIONS, taste, { scalar: { energy: 0 }, genres: {}, decades: {} }),
    ).toBe(taste);
  });

  it("shifts scalar targets within bounds and gives a shifted dim some weight", () => {
    const out = applyAdjust(DIMENSIONS, taste, {
      scalar: { energy: 30, valence: 30 },
      genres: {},
      decades: {},
    });
    expect(out.target).toEqual([85, -70]);
    // energy kept its κ of 100; valence had none and now counts like about two answers.
    expect(out.weight).toEqual([100, AI_MIN_WEIGHT]);
    const top = applyAdjust(
      DIMENSIONS,
      { ...taste, target: [90, -100] },
      {
        scalar: { energy: 30 },
        genres: {},
        decades: {},
      },
    );
    expect(top.target[0]).toBe(100);
  });

  it("boosts move group mass; a group with no preference gets one", () => {
    const out = applyAdjust(DIMENSIONS, taste, {
      scalar: {},
      genres: { jazz: 50 },
      decades: { dec90: 50, dec80: -50 },
    });
    // dec80 700 ÷ 2.5 = 280, dec90 300 × 2.5 = 750 → normalized.
    expect(out.decades).toEqual([272, 728]);
    expect(out.genres?.reduce((a, b) => a + b, 0)).toBe(P_SCALE);
    expect(out.genres?.[2]).toBeGreaterThan(out.genres?.[0] as number);
    expect(out.languages).toEqual(taste.languages);
  });

  it("always gives a valid taste vector (property)", () => {
    const tasteArb = fc.record({
      target: fc.array(fc.integer({ min: -100, max: 100 }), { minLength: 2, maxLength: 2 }),
      weight: fc.array(fc.integer({ min: 0, max: 100 }), { minLength: 2, maxLength: 2 }),
      decades: fc.option(
        fc
          .array(fc.integer({ min: 0, max: 1000 }), { minLength: 2, maxLength: 2 })
          .filter((p) => p.some((x) => x > 0)),
        { nil: null },
      ),
      genres: fc.option(
        fc
          .array(fc.integer({ min: 0, max: 1000 }), { minLength: 4, maxLength: 4 })
          .filter((p) => p.some((x) => x > 0)),
        { nil: null },
      ),
      languages: fc.constant(null),
    });
    fc.assert(
      fc.property(tasteArb, adjustArb(DIMENSIONS), (t, adj) => {
        const out = applyAdjust(DIMENSIONS, t, adj);
        validateTaste(DIMENSIONS, out);
        out.target.forEach((x, d) => {
          expect(Math.abs(x - (t.target[d] as number))).toBeLessThanOrEqual(MAX_SCALAR_DELTA);
        });
      }),
    );
  });

  it("clampAdjust turns any model output into a valid adjustment", () => {
    const raw = {
      scalar: { energy: 0.9, valence: -0.004, made_up: 0.2 },
      genres: { jazz: Number.NaN, rock: -3, pop: 0.123 },
      decades: { dec80: Number.POSITIVE_INFINITY },
    };
    const adj = clampAdjust(DIMENSIONS, raw);
    expect(adj).toEqual({ scalar: { energy: 30 }, genres: { rock: -50, pop: 12 }, decades: {} });
    validateAdjust(DIMENSIONS, adj);
  });

  it("validateAdjust rejects unknown keys and out-of-range values", () => {
    const bad: TasteAdjust[] = [
      { scalar: { tempo: 10 }, genres: {}, decades: {} },
      { scalar: { energy: 31 }, genres: {}, decades: {} },
      { scalar: {}, genres: { rock: 1.5 }, decades: {} },
      { scalar: {}, genres: {}, decades: { dec80: -51 } },
    ];
    for (const adj of bad) expect(() => validateAdjust(DIMENSIONS, adj)).toThrow();
  });
});

describe("AI rerank on a shortlist (HANDOFF §10.2 T2)", () => {
  const DIMS: Bank["dimensions"] = {
    scalar: ["energy", "tempo", "mainstream"],
    decades: ["dec80", "dec90", "dec00"],
    genres: ["rock", "pop", "jazz"],
    languages: ["lang_en"],
  };
  function catalog(n: number): CatalogColumns {
    const rng = createRng("00000000000000ab");
    const rows: ColumnRow[] = [];
    for (let i = 0; i < n; i++) {
      const g = DIMS.genres[rng.int(3)] as string;
      rows.push({
        scalars: { energy: rng.next() * 2 - 1, tempo: rng.next() * 2 - 1, mainstream: 0.5 },
        confidence: 0.8,
        clusters: { [g]: 1 },
        primary: g,
        decade: DIMS.decades[rng.int(3)] as string,
        language: "lang_en",
        artist: rng.int(Math.floor(n / 4)),
        titleKey: rng.int(n * 4),
        year: 1990,
      });
    }
    return buildColumns(DIMS, "rerank-test", rows);
  }
  const columns = catalog(1500);
  const t: TasteVector = {
    target: [40, 0, 60],
    weight: [80, 0, 12],
    decades: [500, 300, 200],
    genres: [600, 300, 100],
    languages: null,
  };
  const SEED = "0123456789abcdef";

  it("shortlist lengths: three per slot, at most 150", () => {
    expect([1, 25, 50, 100].map(shortlistLength)).toEqual([3, 75, 150, 150]);
    expect(shortlistLength(200)).toBe(200);
    expect(MAX_SHORTLIST).toBe(150);
  });

  it("any model answer, even nonsense, gives a §9.3-valid playlist of exactly N", () => {
    for (const n of [25, 50]) {
      const shortlist = generate(columns, t, { length: shortlistLength(n), seed: SEED }).tracks;
      fc.assert(
        fc.property(
          fc.array(fc.oneof(fc.integer({ min: -5, max: 200 }), fc.double()), { maxLength: 200 }),
          (order) => {
            const chosen = chooseFromShortlist(columns, shortlist, order, n);
            const play = playShortlist(columns, shortlist, chosen, n);
            const tracks = play.map((p) => shortlist[p]?.index as number);
            expect(checkPlaylist(columns, tracks, n)).toEqual([]);
            // A valid choice replays to the same set.
            expect([...play].sort((a, b) => a - b)).toEqual(chosen);
          },
        ),
        { numRuns: 40 },
      );
    }
  });

  it("the model's picks win within each cell, and the cell mix is kept", () => {
    const n = 25;
    const shortlist = generate(columns, t, { length: shortlistLength(n), seed: SEED }).tracks;
    // The model prefers the end of the list (the lowest scores).
    const order = shortlist.map((_, p) => shortlist.length - 1 - p);
    const chosen = chooseFromShortlist(columns, shortlist, order, n);
    const byScore = chooseFromShortlist(columns, shortlist, [], n);
    expect(chosen).not.toEqual(byScore);
    const mix = (ps: number[]) => {
      const m = new Map<string, number>();
      for (const p of ps) {
        const k = `${shortlist[p]?.genre}|${shortlist[p]?.decade}`;
        m.set(k, (m.get(k) ?? 0) + 1);
      }
      return m;
    };
    expect(mix(chosen)).toEqual(mix(byScore));
  });

  it("replaying chosen positions needs no model and is deterministic", () => {
    const n = 50;
    const shortlist = generate(columns, t, { length: shortlistLength(n), seed: SEED }).tracks;
    const chosen = chooseFromShortlist(columns, shortlist, [149, 3, 77, 3, 1000, -1], n);
    const a = playShortlist(columns, shortlist, chosen, n);
    const again = generate(columns, t, { length: shortlistLength(n), seed: SEED }).tracks;
    expect(playShortlist(columns, again, chosen, n)).toEqual(a);
  });
});

describe("share format 2 (AI fields)", () => {
  const base: ShareData = {
    taste,
    tweaks: { energy: 1 },
    seed: "0123456789abcdef",
    length: 25,
    answered: 20,
    engineVersion: "0.4.0+bank.3252eb1c",
    catalogVersion: "catalog-2026.09.2",
    ops: [{ op: "more" }],
  };
  const ai: ShareData = {
    ...base,
    adjust: { scalar: { valence: -20 }, genres: { jazz: 35, rock: -10 }, decades: { dec90: 50 } },
    picks: [0, 1, 7, 64, 149],
    title: "Rainy Sunday, דרך ארוכה 🌧️",
    blurb: "Slow guitars and late-night jazz for a grey afternoon.",
  };

  it("a share without AI fields is still format 1, byte for byte", () => {
    const code = encodeShare(DIMENSIONS, base);
    expect(code.startsWith("A")).toBe(true); // first byte 0x01
    expect(encodeShare(DIMENSIONS, { ...base, adjust: EMPTY_ADJUST })).toBe(code);
    expect(decodeShare(DIMENSIONS, code)).toEqual(base);
  });

  it("round-trips the adjustment, picks, and UTF-8 title and blurb", () => {
    const code = encodeShare(DIMENSIONS, ai);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShare(DIMENSIONS, code)).toEqual(ai);
    for (const one of [
      { adjust: ai.adjust },
      { picks: ai.picks },
      { title: ai.title },
      { blurb: ai.blurb },
    ]) {
      const d = { ...base, ...one };
      expect(decodeShare(DIMENSIONS, encodeShare(DIMENSIONS, d))).toEqual(d);
    }
  });

  it("round-trips any valid adjustment and picks (property)", () => {
    const picksArb = fc
      .uniqueArray(fc.integer({ min: 0, max: MAX_SHORTLIST - 1 }), { minLength: 1, maxLength: 25 })
      .map((p) => p.sort((a, b) => a - b));
    fc.assert(
      fc.property(
        adjustArb(DIMENSIONS),
        picksArb,
        fc.string({ minLength: 1, maxLength: 60 }),
        (adj, picks, s) => {
          const clean = (m: Record<string, number>) =>
            Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0));
          const adjust = {
            scalar: clean(adj.scalar),
            genres: clean(adj.genres),
            decades: clean(adj.decades),
          };
          // biome-ignore lint/suspicious/noControlCharactersInRegex: share titles reject them
          const title = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, "x");
          const d: ShareData = { ...base, adjust, picks, title };
          const out = decodeShare(DIMENSIONS, encodeShare(DIMENSIONS, d));
          expect(out.picks).toEqual(picks);
          expect(out.title).toBe(title);
          expect(out.adjust ?? EMPTY_ADJUST).toEqual(
            Object.values(adjust).some((m) => Object.keys(m).length) ? adjust : EMPTY_ADJUST,
          );
        },
      ),
    );
  });

  it("rejects bad AI fields", () => {
    const bad: Partial<ShareData>[] = [
      { picks: [] },
      { picks: [3, 3] },
      { picks: [5, 2] },
      { picks: [150] },
      { picks: Array.from({ length: 26 }, (_, i) => i) },
      { title: "" },
      { title: "x".repeat(MAX_TITLE_CHARS + 1) },
      { blurb: "y".repeat(MAX_BLURB_CHARS + 1) },
      { title: "bell\u0007" },
      { adjust: { scalar: { energy: 99 }, genres: {}, decades: {} } },
    ];
    for (const b of bad)
      expect(() => encodeShare(DIMENSIONS, { ...base, ...b })).toThrow(ShareError);
  });

  it("rejects malformed format 2 codes", () => {
    const bytes = Buffer.from(encodeShare(DIMENSIONS, ai), "base64url");
    const truncated = bytes.subarray(0, bytes.length - 3).toString("base64url");
    expect(() => decodeShare(DIMENSIONS, truncated)).toThrow(ShareError);
    const overlong = Buffer.from(encodeShare(DIMENSIONS, { ...base, title: "A" }), "base64url");
    overlong[overlong.length - 1] = 0xc0; // 0xC0 never starts valid UTF-8
    expect(() => decodeShare(DIMENSIONS, overlong.toString("base64url"))).toThrow(ShareError);
    const v1 = Buffer.from(encodeShare(DIMENSIONS, base), "base64url");
    v1[0] = 2; // format 2 without its flags byte
    expect(() => decodeShare(DIMENSIONS, v1.toString("base64url"))).toThrow(ShareError);
  });
});
