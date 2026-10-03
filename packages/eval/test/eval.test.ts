import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { type Bank, buildColumns, type Question } from "@abtune/engine";
import { describe, expect, it } from "vitest";
import {
  checkPersona,
  fitTables,
  loadPersonas,
  type Persona,
  parseCanon,
  personaChoice,
  playlistMetrics,
  recognition,
  summarize,
  trackFit,
  utility,
} from "../src/index.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));
const loaded = await loadBankFromDisk(["*.yaml"], { cwd: path.join(REPO, "data/questions") });
const bank = loaded.bank as Bank;

const persona = (over: Partial<Persona> = {}): Persona => ({
  id: "p",
  name: "P",
  clusters: { metal: 1, punk: 0.5 },
  decades: { dec80: 1 },
  languages: { lang_en: 1 },
  scalars: { energy: [0.5, 1] },
  ...over,
});

const question = (a: Record<string, number>, b: Record<string, number>): Question => ({
  id: "q",
  pack: "core",
  pri: 50,
  weight: 1,
  a: { label: "a", emoji: "a", fx: a },
  b: { label: "b", emoji: "b", fx: b },
});

describe("personas (data/personas)", async () => {
  const personas = await loadPersonas(path.join(REPO, "data/personas"), bank.dimensions);

  it("has the 12 eval personas of HANDOFF §17, French swapped for Hebrew rock & pop", () => {
    expect(personas).toHaveLength(12);
    const ids = personas.map((p) => p.id);
    expect(ids).toContain("hebrew_rock_pop");
    expect(ids).toContain("hebrew_mizrahi_party");
    expect(ids.some((id) => id.includes("french"))).toBe(false);
  });

  it("rejects keys the bank doesn't declare", () => {
    expect(() => checkPersona(persona({ clusters: { polka: 1 } }), bank.dimensions)).toThrow(
      /polka/,
    );
    expect(() =>
      checkPersona(persona({ scalars: { loudness: [0, 1] } }), bank.dimensions),
    ).toThrow();
    expect(() => checkPersona(persona({ languages: { none: 1 } }), bank.dimensions)).not.toThrow();
  });
});

describe("persona answerer", () => {
  const p = persona();

  it("scores scalars by how much closer than neutral they land", () => {
    expect(utility(bank, p, { energy: 0.75 })).toBeCloseTo(0.75);
    expect(utility(bank, p, { energy: -0.5 })).toBeCloseTo(-0.5);
    expect(utility(bank, p, { valence: 1 })).toBe(0); // not a persona dim
  });

  it("rewards target categories and penalizes others in targeted groups only", () => {
    expect(utility(bank, p, { punk: 1 })).toBeCloseTo(0.5);
    expect(utility(bank, p, { pop: 1 })).toBeCloseTo(-0.5);
    expect(utility(bank, p, { pop: -1 })).toBeCloseTo(0.5);
    expect(utility(bank, persona({ decades: undefined }), { dec90: 1 })).toBe(0);
  });

  it("picks the closer side; near-ties are both (liked) or skip (indifferent)", () => {
    expect(personaChoice(bank, p, question({ metal: 1 }, { pop: 1 }))).toBe("a");
    expect(personaChoice(bank, p, question({ pop: 1 }, { metal: 1 }))).toBe("b");
    expect(personaChoice(bank, p, question({ metal: 1 }, { metal: 1 }))).toBe("both");
    expect(personaChoice(bank, p, question({ valence: 1 }, { valence: -1 }))).toBe("skip");
  });
});

describe("metrics", () => {
  const dims = bank.dimensions;
  const row = (over: Partial<Parameters<typeof buildColumns>[2][number]>) => ({
    scalars: { energy: 0.8 },
    confidence: 1,
    clusters: { metal: 1 },
    primary: "metal",
    decade: "dec80",
    language: "lang_en",
    artist: 0,
    titleKey: 0,
    year: 1985,
    ...over,
  });
  const columns = buildColumns(dims, "t", [
    row({}),
    row({ clusters: { metal: 0.5, pop: 0.5 }, artist: 1, titleKey: 1 }),
    row({ decade: "dec90", artist: 2, titleKey: 2 }),
    row({ scalars: { energy: 0 }, language: "none", artist: 3, titleKey: 3 }),
  ]);
  const t = fitTables(columns, persona());

  it("fit = cluster share × decade × language × scalar ranges met", () => {
    expect(trackFit(columns, t, 0)).toEqual({
      cluster: 1,
      decade: 1,
      language: 1,
      scalar: 1,
      fit: 1,
      fit2: 1,
    });
    expect(trackFit(columns, t, 1).fit).toBeCloseTo(0.5);
    // fit2 doesn't penalize a hit tagged metal and pop half-and-half.
    expect(trackFit(columns, t, 1).fit2).toBeCloseTo(1);
    expect(trackFit(columns, t, 2).fit).toBe(0);
    expect(trackFit(columns, t, 3)).toMatchObject({ language: 0, scalar: 0, fit: 0 });
    const lenient = fitTables(columns, persona({ languages: { lang_en: 1, none: 1 } }));
    expect(trackFit(columns, lenient, 3).language).toBe(1);
  });

  it("playlist metrics average the fit and measure spread", () => {
    const m = playlistMetrics(columns, t, [0, 1, 2, 3]);
    expect(m.fit).toBeCloseTo(0.375);
    expect(m.artistSpread).toBe(1);
    expect(m.year).toBe(1985);
  });

  it("summaries flag a fit that doesn't rise with depth", () => {
    const at = (mode: number, fit: number) =>
      ({ mode, persona: { id: "p" }, metrics: { fit }, playlists: [] }) as unknown as Parameters<
        typeof summarize
      >[0][number];
    expect(summarize([at(10, 0.1), at(20, 0.2), at(50, 0.3)])).toMatchObject({ monotone: true });
    const flat = summarize([at(10, 0.1), at(20, 0.1), at(50, 0.3)]);
    expect(flat.monotone).toBe(false);
    expect(summarize([at(10, 0.1), at(20, 0.1)]).margin).toBe(0);
    // Amended 2026-10-04: the deepest step may dip by up to DEEP_DIP (0.05), no more.
    expect(summarize([at(10, 0.1), at(20, 0.2), at(50, 0.17)]).monotone).toBe(true);
    expect(summarize([at(10, 0.1), at(20, 0.2), at(50, 0.14)]).monotone).toBe(false);
  });

  it("recognition: canon hits per 100, signature songs of famous artists, hits view, Hebrew", () => {
    const tiered = {
      ...columns,
      tier: Uint8Array.from([0, 1, 2, 0]),
      artistRank: Uint8Array.from([1, 4, 1, 2]),
      seasonal: new Uint8Array(4),
    };
    // Artists 0–3 each have one track; artist 2's best song has no top-list listeners at all.
    const recog = recognition(tiered, [1], Float64Array.from([500, 300, 0, 100]));
    expect([...recog.canon]).toEqual([0, 1, 0, 0]);
    expect([...recog.signature]).toEqual([1, 0, 1, 1]);
    const m = playlistMetrics(tiered, t, [0, 1, 2, 3], recog);
    expect(m.canon).toBe(25);
    expect(m.sig).toBe(0.75);
    expect(m.hits).toBe(0.5);
    expect(m.hebrew).toBe(0);
  });

  it("parses the canon list: market, artist and title alternatives, comments skipped", () => {
    const text = [
      "# hits",
      "intl\tQueen\tBohemian Rhapsody",
      "il\tעומר אדם,Omer Adam\tתל אביב,Tel Aviv",
      "",
    ].join("\n");
    expect(parseCanon(text)).toEqual([
      { market: "intl", artists: ["Queen"], titles: ["Bohemian Rhapsody"] },
      { market: "il", artists: ["עומר אדם", "Omer Adam"], titles: ["תל אביב", "Tel Aviv"] },
    ]);
    expect(() => parseCanon("intl\tQueen\n")).toThrow(/3 columns/);
  });
});
