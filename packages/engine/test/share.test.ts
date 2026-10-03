import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  applyEdit,
  decodeShare,
  editStep,
  encodeShare,
  firstStep,
  followUpSeed,
  MAX_SHARE_OPS,
  MORE_LENGTH,
  P_SCALE,
  type ShareData,
  ShareError,
  type ShareOp,
  TARGET_SCALE,
  type TasteVector,
  WEIGHT_SCALE,
} from "../src/index.ts";
import { DIMENSIONS } from "./fixtures.ts";

const taste: TasteVector = {
  target: [55, -100],
  weight: [100, 0],
  decades: [700, 300],
  genres: null,
  languages: [1000, 0],
};
const data: ShareData = {
  taste,
  tweaks: { energy: 2, popularity: -1 },
  seed: "0123456789abcdef",
  length: 25,
  answered: 50,
  engineVersion: "0.4.0+bank.3252eb1c",
  catalogVersion: "catalog-2026.09.2",
  ops: [{ op: "more" }, { op: "swap", index: 7 }, { op: "more" }],
};

describe("share codes (HANDOFF §4.4)", () => {
  it("round-trips everything, and is URL-safe", () => {
    const code = encodeShare(DIMENSIONS, data);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeShare(DIMENSIONS, code)).toEqual(data);
  });

  it("is standard base64url: Node decodes and re-encodes it to the same text", () => {
    const { Buffer } = globalThis as unknown as {
      Buffer: { from(s: string, enc: string): { toString(enc: string): string; length: number } };
    };
    for (const ops of [[], [{ op: "more" as const }], data.ops]) {
      const code = encodeShare(DIMENSIONS, { ...data, ops });
      expect(Buffer.from(code, "base64url").toString("base64url")).toBe(code);
    }
  });

  it("round-trips any valid taste vector", () => {
    const scalar = fc.array(fc.integer({ min: -TARGET_SCALE, max: TARGET_SCALE }), {
      minLength: 2,
      maxLength: 2,
    });
    const weights = fc.array(fc.integer({ min: 0, max: WEIGHT_SCALE }), {
      minLength: 2,
      maxLength: 2,
    });
    const dist = (n: number) =>
      fc.option(
        fc
          .array(fc.integer({ min: 0, max: P_SCALE }), { minLength: n, maxLength: n })
          .filter((p) => p.some((x) => x > 0)),
        { nil: null },
      );
    fc.assert(
      fc.property(
        scalar,
        weights,
        dist(2),
        dist(4),
        dist(2),
        fc.integer({ min: 1, max: 100 }),
        fc.integer({ min: 0, max: 500 }),
        (target, weight, decades, genres, languages, length, answered) => {
          const d: ShareData = {
            ...data,
            taste: { target, weight, decades, genres, languages },
            length,
            answered,
          };
          expect(decodeShare(DIMENSIONS, encodeShare(DIMENSIONS, d))).toEqual(d);
        },
      ),
    );
  });

  it("rejects codes that are malformed, truncated, padded or for other dimensions", () => {
    const code = encodeShare(DIMENSIONS, data);
    const bad = [
      "",
      "%%%",
      code.slice(0, -3),
      `${code}AA`,
      `B${code.slice(1)}`, // format byte 4–7
    ];
    for (const c of bad) expect(() => decodeShare(DIMENSIONS, c)).toThrow(ShareError);
    const other = { ...DIMENSIONS, scalar: [...DIMENSIONS.scalar, "tempo"] };
    expect(() => decodeShare(other, code)).toThrow(/expected 3 dims/);
  });

  it("refuses to encode invalid data", () => {
    expect(() => encodeShare(DIMENSIONS, { ...data, seed: "xyz" })).toThrow(ShareError);
    expect(() => encodeShare(DIMENSIONS, { ...data, length: 0 })).toThrow(ShareError);
    expect(() => encodeShare(DIMENSIONS, { ...data, tweaks: { energy: 5 } })).toThrow(ShareError);
    const ops = Array.from({ length: MAX_SHARE_OPS + 1 }, () => ({ op: "more" as const }));
    expect(() => encodeShare(DIMENSIONS, { ...data, ops })).toThrow(ShareError);
    expect(() =>
      encodeShare(DIMENSIONS, { ...data, taste: { ...taste, target: [500, 0] } }),
    ).toThrow(ShareError);
  });
});

describe("playlist edits (owner decision D9)", () => {
  it("pins the follow-up seeds: share links made earlier must replay the same songs", () => {
    expect(followUpSeed("0123456789abcdef", "more", 1)).toBe("c25ac26b38f9b54d");
    expect(followUpSeed("0123456789abcdef", "swap", 2)).toBe("cc1adc674e0f9f20");
  });

  it("numbers pages and swaps separately and applies them to the list", () => {
    const first = firstStep(DIMENSIONS, taste, {}, "0123456789abcdef", 3);
    const done: ShareOp[] = [{ op: "more" }, { op: "swap", index: 0 }];
    const more = editStep(DIMENSIONS, taste, {}, first, done, { op: "more" });
    expect(more.seed).toBe(followUpSeed(first.seed, "more", 2));
    expect([more.length, more.swap]).toEqual([MORE_LENGTH, false]);
    const swap = editStep(DIMENSIONS, taste, {}, first, done, { op: "swap", index: 1 });
    expect(swap.seed).toBe(followUpSeed(first.seed, "swap", 2));
    expect([swap.length, swap.swap, swap.taste]).toEqual([1, true, first.taste]);
    expect(applyEdit(["a", "b", "c"], { op: "swap", index: 1 }, ["x"])).toEqual(["a", "x", "c"]);
    expect(applyEdit(["a"], { op: "more" }, ["x", "y"])).toEqual(["a", "x", "y"]);
  });
});
