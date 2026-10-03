import { describe, expect, it } from "vitest";
import {
  type AnswerEvent,
  eligibleQuestions,
  foldProfile,
  inSlot,
  nextQuestion,
  scoreQuestion,
  slotFor,
} from "../src/index.ts";
import { makeBank, q } from "./fixtures.ts";

describe("pacing (HANDOFF §8.3)", () => {
  it("assigns slots by 1-based position", () => {
    const off = Array.from({ length: 20 }, (_, i) => slotFor(i + 1, false));
    expect(off.slice(0, 3)).toEqual(["hook", "hook", "hook"]);
    expect([4, 8, 12, 16, 20].map((p) => off[p - 1])).toEqual(Array(5).fill("vibe"));
    expect(off.filter((s) => s === "spicy")).toEqual([]);
    expect(slotFor(7, true)).toBe("spicy");
    expect(slotFor(17, true)).toBe("spicy");
    expect(slotFor(7, false)).toBe("main");
  });

  it("puts community packs in the main slot", () => {
    expect(inSlot("community", "main")).toBe(true);
    expect(inSlot("deep", "main")).toBe(true);
    expect(inSlot("vibe", "main")).toBe(false);
    expect(inSlot("spicy", "main")).toBe(false);
    expect(inSlot("context", "hook")).toBe(false);
  });
});

describe("eligibility and unlocks", () => {
  const root = q("root_q", "core", 90, { rock: 1 }, { pop: 1 });
  const gated = q(
    "gated_q",
    "deep",
    50,
    { energy: 1 },
    { energy: -1 },
    { unlock_if: { any: ["root_q=a"] } },
  );
  const byGenre = q(
    "genre_q",
    "deep",
    50,
    { valence: 1 },
    { valence: -1 },
    { unlock_if: { top_genres: ["pop"] } },
  );
  const spicy = q("spicy_q", "spicy", 50, { energy: 0.2 }, { energy: -0.2 });
  const bank = makeBank([root, gated, byGenre, spicy]);
  const packs = new Set(["core", "deep"]);
  const ids = (log: AnswerEvent[]) =>
    eligibleQuestions(bank, foldProfile(bank, log), log, packs).map((x) => x.id);

  it("hides locked and disabled questions", () => {
    expect(ids([])).toEqual(["root_q"]);
  });

  it("unlocks by answer; Both satisfies either side; skip satisfies neither", () => {
    expect(ids([{ id: "root_q", choice: "a" }])).toEqual(["gated_q"]);
    expect(ids([{ id: "root_q", choice: "both" }])).toEqual(["gated_q", "genre_q"]);
    expect(ids([{ id: "root_q", choice: "b" }])).toEqual(["genre_q"]);
    expect(ids([{ id: "root_q", choice: "skip" }])).toEqual([]);
  });

  it("unlocks by top-3 genre with positive score", () => {
    expect(ids([{ id: "root_q", choice: "b" }])).toContain("genre_q");
  });
});

describe("scoring and choice", () => {
  it("computes information gain × priority factor", () => {
    const x = q("x", "core", 50, { energy: 0.5, rock: 1 }, { energy: -0.5, pop: 1 });
    const bank = makeBank([x]);
    const none = { igNorm: "none" } as const;
    // energy |1|·(1/C=1) + rock 1·1/(1+0) + pop 1·1/(1+0) = 3; × (0.5 + 0.5)
    expect(scoreQuestion(bank, foldProfile(bank, []), x, none)).toBe(3);
    const vibe = q("v", "vibe", 50, { energy: 1 }, { energy: -1 });
    expect(
      scoreQuestion(makeBank([vibe]), foldProfile(makeBank([vibe]), []), vibe, none),
    ).toBeCloseTo(0.8);
    // §18 normalizations divide by the 3 keys (the default) or by √3.
    expect(scoreQuestion(bank, foldProfile(bank, []), x)).toBe(1);
    expect(scoreQuestion(bank, foldProfile(bank, []), x, { igNorm: "sqrt" })).toBeCloseTo(
      3 / Math.sqrt(3),
    );
  });

  it("discounts dims that already have evidence", () => {
    const x = q("x", "core", 50, { energy: 1 }, { energy: -1 });
    const y = q("y", "core", 50, { energy: 1 }, { energy: -1 });
    const bank = makeBank([x, y]);
    const after = foldProfile(bank, [{ id: "x", choice: "a" }]);
    expect(scoreQuestion(bank, after, y)).toBe(2 * (1 / 2));
  });

  it("breaks exact ties by id (code units), never by locale", () => {
    const twins = ["q_b", "q_a", "Q_c"].map((id) =>
      q(id, "core", 50, { energy: 1 }, { energy: -1 }),
    );
    const bank = makeBank(twins);
    const pick = nextQuestion(bank, foldProfile(bank, []), [], new Set(["core"]), 1);
    expect(pick?.id).toBe("Q_c"); // "Q" (0x51) < "q" (0x71)
  });

  it("falls back to any eligible question when the slot is empty", () => {
    const bank = makeBank([q("only_vibe", "vibe", 50, { energy: 1 }, { energy: -1 })]);
    expect(nextQuestion(bank, foldProfile(bank, []), [], new Set(["vibe"]), 1)?.id).toBe(
      "only_vibe",
    );
  });
});

describe("variety: quiz seeds and question families (owner decision D7)", () => {
  // Five near-equal main cards and two vibe moods; one family with two variants of the opener.
  const opener = q("opener", "core", 90, { rock: 1, energy: 0.5 }, { pop: 1, energy: -0.5 });
  const v2 = q(
    "opener_v2",
    "core",
    90,
    { rock: 1, energy: 0.4 },
    { pop: 1, energy: -0.6 },
    {
      family: "opener",
    },
  );
  const v3 = q(
    "opener_v3",
    "core",
    90,
    { rock: 1, energy: 0.6 },
    { pop: 1, energy: -0.4 },
    {
      family: "opener",
    },
  );
  const follow = q(
    "follow",
    "deep",
    60,
    { metal: 1 },
    { jazz: 1 },
    { unlock_if: { any: ["opener=a"] } },
  );
  const mains = ["m1", "m2", "m3", "m4", "m5"].map((id, k) =>
    q(id, "core", 70 - k, { valence: 1 }, { valence: -1 }),
  );
  const bank = makeBank([opener, v2, v3, follow, ...mains]);
  const packs = new Set(["core", "deep"]);
  const first = (seed: string | null, avoid: string[] = []) =>
    nextQuestion(bank, foldProfile(bank, []), [], packs, 1, {}, { seed, avoid })?.id;

  it("without a seed asks only canonical questions, deterministically", () => {
    expect(first(null)).toBe("opener");
    const ids = eligibleQuestions(bank, foldProfile(bank, []), [], packs).map((x) => x.id);
    expect(ids).toContain("opener_v2"); // eligible, but never chosen without a seed
  });

  it("with a seed picks a variant, reproducibly, and avoids the previous session's", () => {
    const seen = new Set<string>();
    for (let s = 0; s < 40; s++) {
      const seed = s.toString(16).padStart(16, "0");
      const id = first(seed);
      expect(first(seed)).toBe(id);
      seen.add(id as string);
    }
    expect([...seen].sort()).toEqual(["opener", "opener_v2", "opener_v3"]);
    for (let s = 0; s < 20; s++) {
      const seed = s.toString(16).padStart(16, "1");
      expect(first(seed, ["opener", "opener_v2"])).toBe("opener_v3");
    }
  });

  it("uses up the whole family once one variant is asked; unlocks follow the family", () => {
    const log: AnswerEvent[] = [{ id: "opener_v3", choice: "a" }];
    const ids = eligibleQuestions(bank, foldProfile(bank, log), log, packs).map((x) => x.id);
    expect(ids).not.toContain("opener");
    expect(ids).not.toContain("opener_v2");
    expect(ids).toContain("follow"); // unlock_if opener=a, answered through a variant
  });

  it("draws main cards within the band of the best, and replays the same draw after Back", () => {
    const log: AnswerEvent[] = [{ id: "opener", choice: "b" }];
    const profile = foldProfile(bank, log);
    const picks = new Set<string>();
    for (let s = 0; s < 60; s++) {
      const seed = s.toString(16).padStart(16, "2");
      const a = nextQuestion(bank, profile, log, packs, 5, {}, { seed });
      const b = nextQuestion(bank, profile, log, packs, 5, {}, { seed });
      expect(b?.id).toBe(a?.id);
      picks.add(a?.id as string);
    }
    expect(picks.size).toBeGreaterThan(1); // m1–m5 score within 10% of each other
  });
});
