import { describe, expect, it } from "vitest";
import {
  type Dimensions,
  foldProfile,
  hintKey,
  profileHints,
  scalarLabel,
  type TasteVector,
  tasteVector,
} from "../src/index.ts";
import { makeBank, q } from "./fixtures.ts";

const DIMS: Dimensions = {
  scalar: ["energy", "valence", "acoustic", "mainstream"],
  decades: ["dec70", "dec80", "dec90", "dec00"],
  genres: ["rock", "pop", "jazz"],
  languages: ["lang_en", "lang_he", "lang_other"],
};

const neutral: TasteVector = {
  target: [0, 0, 0, 0],
  weight: [0, 0, 0, 0],
  decades: null,
  genres: null,
  languages: null,
};

const taste = (t: Partial<TasteVector>): TasteVector => ({ ...neutral, ...t });

describe("profileHints", () => {
  it("says nothing without evidence", () => {
    expect(profileHints(DIMS, neutral)).toEqual([]);
  });

  it("names one decade, or two adjacent ones in chronological order", () => {
    expect(profileHints(DIMS, taste({ decades: [50, 800, 100, 50] }))).toEqual([
      { kind: "era", decades: ["dec80"] },
    ]);
    expect(profileHints(DIMS, taste({ decades: [50, 300, 600, 50] }))).toEqual([
      { kind: "era", decades: ["dec80", "dec90"] },
    ]);
    expect(profileHints(DIMS, taste({ decades: [0, 50, 470, 480] }))).toEqual([
      { kind: "era", decades: ["dec90", "dec00"] },
    ]);
    expect(profileHints(DIMS, taste({ decades: [250, 250, 250, 250] }))).toEqual([]);
  });

  it("names the top genre, or two when close", () => {
    expect(profileHints(DIMS, taste({ genres: [700, 200, 100] }))).toEqual([
      { kind: "genre", genres: ["rock"] },
    ]);
    expect(profileHints(DIMS, taste({ genres: [300, 400, 300] }))).toEqual([
      { kind: "genre", genres: ["pop", "rock"] },
    ]);
    expect(profileHints(DIMS, taste({ genres: [340, 330, 330] }))).toEqual([]);
  });

  it("calls out a non-English language and clear scalar leans, genre first", () => {
    const hints = profileHints(
      DIMS,
      taste({
        target: [60, -50, 10, 80],
        weight: [100, 70, 100, 50],
        genres: [800, 100, 100],
        languages: [300, 600, 100],
      }),
    );
    expect(hints.map(hintKey)).toEqual([
      "genre:rock",
      "language:lang_he",
      "scalar:energy:high",
      "scalar:valence:low",
    ]);
  });

  it("ignores English and weakly evidenced scalars", () => {
    expect(
      profileHints(
        DIMS,
        taste({ target: [90, 0, 0, 0], weight: [50, 0, 0, 0], languages: [900, 50, 50] }),
      ),
    ).toEqual([]);
  });

  it("works on a folded profile", () => {
    const bank = makeBank([q("x", "core", 50, { energy: 1, rock: 1, dec80: 1 }, { energy: -1 })]);
    const t = tasteVector(bank, foldProfile(bank, [{ id: "x", choice: "a" }]));
    expect(profileHints(bank.dimensions, t).map(hintKey)).toEqual(["genre:rock"]);
  });
});

describe("scalarLabel", () => {
  it("has poles for the seed's scalars and a fallback", () => {
    expect(scalarLabel("acoustic")).toEqual({ name: "Texture", low: "Electric", high: "Organic" });
    expect(scalarLabel("night_owl")).toEqual({ name: "Night Owl", low: "Low", high: "High" });
  });
});
