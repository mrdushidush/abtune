import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bankFileJsonSchema, type LintOptions, loadBank } from "../src/index.ts";

const SEED_PATH = new URL("../../../data/questions/seed.yaml", import.meta.url);
const seedText = readFileSync(SEED_PATH, "utf8");

const BASE = `version: 1
dimensions:
  scalar: [energy, valence]
  decades: [dec80, dec90]
  genres: [rock, pop]
  languages: [lang_en]
packs:
  core: { weight: 1.0, default: true }
questions:
  - id: q_one
    pack: core
    pri: 50
    a: { label: "A", emoji: "🅰️", fx: { energy: 0.5, rock: 1 } }
    b: { label: "B", emoji: "🅱️", fx: { energy: -0.5, pop: 1 } }
`;

const NO_COVERAGE: LintOptions = { scalarCoverage: 0, genreCoverage: 0 };

function question(id: string, extra = "", a = "{ energy: 0.5 }", b = "{ energy: -0.5 }"): string {
  return `  - id: ${id}
    pack: core
    pri: 50
${extra}    a: { label: "A", emoji: "a", fx: ${a} }
    b: { label: "B", emoji: "b", fx: ${b} }
`;
}

function lintPack(pack: string, options: LintOptions = NO_COVERAGE) {
  return loadBank(
    [
      { path: "base.yaml", text: BASE },
      { path: "pack.yaml", text: `version: 1\n${pack}` },
    ],
    options,
  );
}

const rules = (r: ReturnType<typeof loadBank>) => r.diagnostics.map((d) => d.rule);

describe("seed bank", () => {
  const result = loadBank([{ path: "data/questions/seed.yaml", text: seedText }]);

  it("lints clean with the default rules", () => {
    expect(result.diagnostics).toEqual([]);
  });

  it("has the 153 questions the brief describes", () => {
    const counts: Record<string, number> = {};
    for (const q of result.bank?.questions ?? []) counts[q.pack] = (counts[q.pack] ?? 0) + 1;
    expect(counts).toEqual({ core: 40, context: 6, deep: 56, vibe: 42, spicy: 9 });
  });

  it("defaults question weight to 1", () => {
    expect(result.bank?.questions.every((q) => q.weight === 1)).toBe(true);
  });
});

describe("yaml-level rules", () => {
  it("reports syntax errors", () => {
    const r = loadBank([{ path: "x.yaml", text: "version: 1\nquestions:\n  - id: [unclosed\n" }]);
    expect(rules(r)).toContain("yaml-syntax");
    expect(r.errors).toBeGreaterThan(0);
  });

  it("rejects duplicate keys", () => {
    const r = loadBank([{ path: "x.yaml", text: "version: 1\nversion: 1\n" }]);
    expect(rules(r)).toContain("yaml-syntax");
  });

  it("flags YAML 1.1 booleans (on/off/yes/no) with a position", () => {
    const r = lintPack("packs:\n  extra: { weight: 1, default: on }\n");
    const d = r.diagnostics.find((x) => x.rule === "yaml-boolean");
    expect(d).toMatchObject({ file: "pack.yaml", line: 3, severity: "error" });
  });

  it("does not flag quoted yes/no text", () => {
    const r = lintPack(`questions:\n${question("q_quoted").replace('label: "A"', 'label: "yes"')}`);
    expect(rules(r)).not.toContain("yaml-boolean");
  });
});

describe("schema", () => {
  it("rejects unknown keys and points at the key", () => {
    const r = lintPack(`questions:\n${question("q_typo", "    unlock_iff: { any: [q_one=a] }\n")}`);
    const d = r.diagnostics.find((x) => x.rule === "schema");
    expect(d?.message).toContain("unlock_iff");
    expect(d?.line).toBe(6);
  });

  it("requires emoji and bounds pri", () => {
    const r = lintPack(
      `questions:\n${question("q_bad").replace("pri: 50", "pri: 101").replace('emoji: "a", ', "")}`,
    );
    const messages = r.diagnostics.filter((d) => d.rule === "schema").map((d) => d.message);
    expect(messages.some((m) => m.startsWith("questions.0.pri"))).toBe(true);
    expect(messages.some((m) => m.startsWith("questions.0.a.emoji"))).toBe(true);
  });
});

describe("authoring rules (§8.4)", () => {
  const cases: [rule: string, pack: string][] = [
    ["id-format", `questions:\n${question("BadId")}`],
    ["id-unique", `questions:\n${question("q_one")}`],
    ["pack-unknown", `questions:\n${question("q_x").replace("pack: core", "pack: nope")}`],
    ["pack-duplicate", "packs:\n  core: { weight: 1, default: true }\n"],
    ["pack-name", "packs:\n  BadPack: { weight: 1, default: true }\n"],
    [
      "label-length",
      `questions:\n${question("q_long").replace('label: "A"', 'label: "This label is far too long"')}`,
    ],
    ["fx-empty", `questions:\n${question("q_empty", "", "{}")}`],
    ["fx-unknown-key", `questions:\n${question("q_key", "", "{ rok: 1 }")}`],
    ["fx-range", `questions:\n${question("q_range", "", "{ energy: 1.5 }")}`],
    ["unlock-ref", `questions:\n${question("q_u1", '    unlock_if: { any: ["ghost=a"] }\n')}`],
    ["unlock-ref", `questions:\n${question("q_u2", '    unlock_if: { any: ["q_one=c"] }\n')}`],
    ["unlock-ref", `questions:\n${question("q_u3", '    unlock_if: { any: ["q_u3=a"] }\n')}`],
    ["unlock-ref", `questions:\n${question("q_u4", "    unlock_if: {}\n")}`],
    [
      "unlock-genre",
      `questions:\n${question("q_g", "    unlock_if: { top_genres: [vaporwave] }\n")}`,
    ],
    [
      "unlock-genre",
      `questions:\n${question("q_g2", "    unlock_if: { all_top_genres: [rock, vaporwave] }\n")}`,
    ],
    [
      "unlock-genre",
      `questions:\n${question("q_g3", "    unlock_if: { all_top_genres: [rock, pop, rock, pop] }\n")}`,
    ],
    [
      "sensitive-fx",
      `questions:\n${question("q_s1", "    sensitive: political\n", "{ rock: 0.2 }")}`,
    ],
    [
      "sensitive-fx",
      `questions:\n${question("q_s2", "    sensitive: political\n", "{ energy: 0.5 }")}`,
    ],
    ["family", `questions:\n${question("q_f1", "    family: ghost\n")}`],
    ["family", `questions:\n${question("q_f2", "    family: q_f2\n")}`],
    [
      "family",
      `questions:\n${question("q_f3", "    family: q_one\n")}${question("q_f4", "    family: q_f3\n")}`,
    ],
    [
      "family",
      `packs:\n  deep: { weight: 1, default: true }\nquestions:\n${question("q_f5", "    family: q_one\n").replace("pack: core", "pack: deep")}`,
    ],
    [
      "family",
      `questions:\n${question("q_f6", '    family: q_one\n    unlock_if: { any: ["q_one=a"] }\n')}`,
    ],
    ["family", `questions:\n${question("q_f7", "    family: q_one\n    weight: 1.5\n")}`],
  ];

  it("accepts a variant of a canonical question in the same pack", () => {
    const r = lintPack(`questions:\n${question("q_v", "    family: q_one\n")}`);
    expect(r.diagnostics).toEqual([]);
    expect(r.bank?.questions.find((x) => x.id === "q_v")?.family).toBe("q_one");
  });

  it.each(cases)("%s", (rule, pack) => {
    const r = lintPack(pack);
    expect(rules(r)).toContain(rule);
    expect(r.errors).toBeGreaterThan(0);
  });

  it("points fx-unknown-key at the key", () => {
    const r = lintPack(`questions:\n${question("q_key", "", "{ rok: 1 }")}`);
    const d = r.diagnostics.find((x) => x.rule === "fx-unknown-key");
    expect(d).toMatchObject({ file: "pack.yaml", line: 6 });
  });

  it("counts label length in code points, so accents and emoji are fair", () => {
    const label = "Édith Piaf 🌹 à Paris ✨";
    expect([...label].length).toBeLessThanOrEqual(22);
    const r = lintPack(
      `questions:\n${question("q_ok").replace('label: "A"', `label: "${label}"`)}`,
    );
    expect(rules(r)).not.toContain("label-length");
  });

  it("accepts sensitive questions with small scalar effects", () => {
    const r = lintPack(
      `questions:\n${question("q_s_ok", "    sensitive: political\n", "{ energy: 0.4 }", "{ valence: -0.4 }")}`,
    );
    expect(r.diagnostics).toEqual([]);
  });

  it("enforces coverage with the default thresholds", () => {
    const r = loadBank([{ path: "base.yaml", text: BASE }]);
    expect(rules(r).filter((x) => x === "coverage-scalar")).toHaveLength(2);
    expect(rules(r).filter((x) => x === "coverage-genre")).toHaveLength(2);
  });

  it("requires exactly one file with dimensions", () => {
    const none = loadBank([{ path: "p.yaml", text: "version: 1\nquestions: []\n" }]);
    expect(rules(none)).toContain("dimensions");
    const two = loadBank([
      { path: "a.yaml", text: BASE },
      { path: "b.yaml", text: BASE.split("packs:")[0] ?? "" },
    ]);
    expect(rules(two)).toContain("dimensions");
  });

  it("reports duplicates in the community pack, not the seed", () => {
    const r = loadBank(
      [
        { path: "a_pack.yaml", text: `version: 1\nquestions:\n${question("q_one")}` },
        { path: "z_seed.yaml", text: BASE },
      ],
      NO_COVERAGE,
    );
    const d = r.diagnostics.find((x) => x.rule === "id-unique");
    expect(d?.file).toBe("a_pack.yaml");
    expect(r.bank?.questions[0]?.id).toBe("q_one");
    expect(r.merged?.sources[0]?.parsed.file).toBe("z_seed.yaml");
  });
});

describe("JSON Schema", () => {
  it("enumerates fx keys from the dimensions for editor autocomplete", () => {
    const dims = loadBank([{ path: "base.yaml", text: BASE }], NO_COVERAGE).bank?.dimensions;
    expect(dims).toBeDefined();
    if (!dims) return;
    const json = JSON.stringify(bankFileJsonSchema(dims));
    for (const key of ["energy", "dec80", "rock", "lang_en"]) expect(json).toContain(`"${key}"`);
  });
});
