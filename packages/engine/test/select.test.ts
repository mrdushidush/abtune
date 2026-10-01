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
    // energy |1|·(1/C=1) + rock 1·1/(1+0) + pop 1·1/(1+0) = 3; × (0.5 + 0.5)
    expect(scoreQuestion(bank, foldProfile(bank, []), x)).toBe(3);
    const vibe = q("v", "vibe", 50, { energy: 1 }, { energy: -1 });
    expect(scoreQuestion(makeBank([vibe]), foldProfile(makeBank([vibe]), []), vibe)).toBeCloseTo(
      0.8,
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
