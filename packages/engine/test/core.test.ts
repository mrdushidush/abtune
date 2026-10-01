import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  bankHash,
  canonicalJson,
  computeSeed,
  createRng,
  ENGINE_SEMVER,
  engineVersion,
} from "../src/index.ts";
import { makeBank, q } from "./fixtures.ts";

describe("canonicalJson", () => {
  it("sorts keys, keeps arrays, normalizes -0", () => {
    expect(canonicalJson({ b: 1, a: [1, -0, { d: "x", c: null }] })).toBe(
      '{"a":[1,0,{"c":null,"d":"x"}],"b":1}',
    );
  });

  it("rejects values JSON can't represent", () => {
    expect(() => canonicalJson({ x: Number.NaN })).toThrow();
    expect(() => canonicalJson(() => 1)).toThrow();
  });
});

describe("computeSeed", () => {
  // Known-answer vector, cross-checked with Python hashlib on 2026-10-01.
  it("matches the reference vector", () => {
    expect(
      computeSeed({
        answer_log: [
          { id: "bonjovi_britney", choice: "a" },
          { id: "dec80_dec90", choice: "skip" },
        ],
        mode: 10,
        length: 50,
        packs: ["vibe", "core"],
        catalog_version: "catalog-2026.10",
        engine_version: "0.1.0+bank.deadbeef",
        seed_salt: 0,
      }),
    ).toBe("bf98c5751954ff0d");
  });
});

describe("createRng (sfc32)", () => {
  // Known-answer vector, cross-checked with an independent Python sfc32 on 2026-10-01.
  it("matches the reference stream", () => {
    const rng = createRng("0123456789abcdef");
    expect(Array.from({ length: 5 }, () => rng.nextUint32())).toEqual([
      1564798355, 3170087374, 752220539, 2585452305, 3819889519,
    ]);
  });

  it("produces bounded, roughly uniform integers", () => {
    const rng = createRng("00000000000000ff");
    const counts = [0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 70_000; i++) {
      const x = rng.int(7);
      counts[x] = (counts[x] ?? 0) + 1;
    }
    for (const c of counts) expect(Math.abs(c - 10_000)).toBeLessThan(500);
    const f = rng.next();
    expect(f).toBeGreaterThanOrEqual(0);
    expect(f).toBeLessThan(1);
  });

  it("rejects malformed seeds and bounds", () => {
    expect(() => createRng("xyz")).toThrow();
    expect(() => createRng("0123456789abcdef").int(0)).toThrow();
  });
});

describe("engine version", () => {
  it("matches package.json", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(ENGINE_SEMVER).toBe(pkg.version);
  });

  it("changes when the bank changes", () => {
    const one = makeBank([q("a1", "core", 50, { energy: 1 }, { energy: -1 })]);
    const two = makeBank([q("a1", "core", 50, { energy: 0.9 }, { energy: -1 })]);
    expect(bankHash(one)).toMatch(/^[0-9a-f]{8}$/);
    expect(bankHash(one)).not.toBe(bankHash(two));
    expect(engineVersion(one)).toBe(`${ENGINE_SEMVER}+bank.${bankHash(one)}`);
  });
});

describe("purity (HANDOFF §5.2)", () => {
  // No network, filesystem, clock or global RNG in the engine.
  const forbidden = [
    /\bMath\.random\b/,
    /\bDate\b/,
    /\bperformance\b/,
    /\bprocess\b/,
    /\bfetch\b/,
    /\brequire\(/,
    /from "node:/,
    /\bglobalThis\b/,
    /\b(window|document|localStorage|setTimeout|setInterval)\b/,
  ];
  const dir = new URL("../src/", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it.each(files)("%s uses no IO, clock or global randomness", (file) => {
    const source = readFileSync(new URL(file, dir), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    for (const pattern of forbidden) expect(source).not.toMatch(pattern);
  });
});
