import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeShare,
  encodeShare,
  MAX_SHARE_OPS,
  P_SCALE,
  type ShareData,
  ShareError,
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
