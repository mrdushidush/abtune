import { describe, expect, it } from "vitest";
import {
  type AnswerEvent,
  DEFAULT_DUEL,
  DEFAULT_DUEL_FROM,
  DUEL_MIN_SCORE,
  duelValue,
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
    const explore = Array.from({ length: 24 }, (_, i) => slotFor(i + 1, false, true));
    expect(explore.flatMap((s, i) => (s === "explore" ? [i + 1] : []))).toEqual([5, 9, 13, 17]);
    expect(slotFor(17, true, true)).toBe("spicy");
  });

  it("explore slots ask about a genre no card has touched, highest priority first", () => {
    const rockPop = q("rock_pop", "core", 95, { rock: 1 }, { pop: 1 });
    const strong = q("strong", "core", 90, { energy: 1, rock: 0.5 }, { energy: -1, pop: 0.5 });
    const jazzMetal = q("jazz_metal", "core", 60, { jazz: 1 }, { metal: 1 });
    const bothJazz = q("both_jazz", "core", 99, { jazz: 0.8, energy: 0.3 }, { jazz: 0.7 });
    const bank = makeBank([rockPop, strong, jazzMetal, bothJazz]);
    const log = [{ id: "rock_pop", choice: "a" as const }];
    const pick = (explore: boolean) =>
      nextQuestion(bank, foldProfile(bank, log), log, new Set(["core"]), 5, { explore })?.id;
    // Without explore, IG prefers the strong scalar card. With it, the only card that sets an
    // untouched genre against another: both_jazz names jazz on both sides, so it doesn't count.
    expect(pick(false)).toBe("strong");
    expect(pick(true)).toBe("jazz_metal");
  });

  it("asks a pack's best card at its lead positions, only when the pack is on", () => {
    const rockPop = q("rock_pop", "core", 95, { rock: 1, energy: 1 }, { pop: 1, energy: -1 });
    const jazzMetal = q("jazz_metal", "core", 90, { jazz: 1 }, { metal: 1 });
    const french = q("french", "community", 50, { lang_fr: 1 }, { lang_en: 1 });
    // These two unlock only on a "French" answer, like the Israeli pack's follow-ups on "Lots of
    // Hebrew".
    const frenchToo = q(
      "french_too",
      "community",
      40,
      { lang_fr: 0.5 },
      { lang_en: 0.5 },
      {
        unlock_if: { any: ["french=a"] },
      },
    );
    const chanson = q(
      "chanson",
      "community",
      60,
      { lang_fr: 1, jazz: 0.5 },
      { lang_fr: 1 },
      {
        unlock_if: { any: ["french=a"] },
      },
    );
    const lead = (positions: number[]) => ({
      ...makeBank([rockPop, jazzMetal, french, frenchToo, chanson]),
      packs: { ...makeBank([]).packs, community: { weight: 1, default: false, lead: positions } },
    });
    const log = [{ id: "rock_pop", choice: "a" as const }];
    const at = (position: number, packs: string[], l: AnswerEvent[] = log, positions = [2]) => {
      const bank = lead(positions);
      return nextQuestion(bank, foldProfile(bank, l), l, new Set(packs), position)?.id;
    };
    expect(at(2, ["core", "community"])).toBe("french");
    expect(at(2, ["core"])).toBe("jazz_metal");
    // Off its positions, the pack's cards compete like any other (here: the hook takes core only).
    expect(at(3, ["core", "community"])).toBe("jazz_metal");
    // Once asked, the next card of the pack doesn't take the slot again at a later position.
    const yes = [...log, { id: "french", choice: "a" as const }];
    expect(at(3, ["core", "community"], yes)).toBe("jazz_metal");
    // A skip leaves the position at 2: the pack's next card must not take the slot again.
    const skipped = [...log, { id: "french", choice: "skip" as const }];
    expect(at(2, ["core", "community"], skipped)).toBe("jazz_metal");
    // With [2, 3], the second slot asks the pack's best card unlocked by then...
    expect(at(3, ["core", "community"], yes, [2, 3])).toBe("chanson");
    // ...and falls back to the normal card when the first answer unlocked none.
    const no = [...log, { id: "french", choice: "b" as const }];
    expect(at(3, ["core", "community"], no, [2, 3])).toBe("jazz_metal");
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

  it("all_top_genres needs every listed genre in the top 3", () => {
    const duel = q(
      "duel_q",
      "deep",
      50,
      { rock: 1 },
      { jazz: 1 },
      {
        unlock_if: { all_top_genres: ["rock", "jazz"] },
      },
    );
    const rockOnly = q("rock_only", "core", 50, { rock: 1 }, { pop: 1 });
    const rockJazz = q("rock_jazz", "core", 50, { rock: 1, jazz: 0.5 }, { pop: 1 });
    const b = makeBank([rockOnly, rockJazz, duel]);
    const open = (log: AnswerEvent[]) =>
      eligibleQuestions(b, foldProfile(b, log), log, packs).some((x) => x.id === "duel_q");
    expect(open([{ id: "rock_only", choice: "a" }])).toBe(false);
    expect(open([{ id: "rock_jazz", choice: "a" }])).toBe(true);
  });
});

describe("genre duels", () => {
  const duel = q("duel", "core", 50, { rock: 1 }, { jazz: 1 });
  const same = q("same", "core", 50, { rock: 1 }, { rock: 0.5 });
  const rockJazz = q("rock_jazz", "core", 50, { rock: 1, jazz: 1 }, { pop: 1 });
  const rockHalfJazz = q("rock_half_jazz", "core", 50, { rock: 1, jazz: 0.5 }, { pop: 1 });
  const rockMore = q("rock_more", "core", 50, { rock: 1 }, { pop: 1 });
  const bank = makeBank([duel, same, rockJazz, rockHalfJazz, rockMore]);

  it("values a card by how evenly matched the two genres it splits are", () => {
    expect(duelValue(bank, foldProfile(bank, []), duel)).toBe(0);
    const tied = foldProfile(bank, [{ id: "rock_jazz", choice: "a" }]);
    expect(duelValue(bank, tied, duel)).toBe(1);
    // Both sides add rock: nothing to settle.
    expect(duelValue(bank, tied, same)).toBe(0);
    const behind = foldProfile(bank, [
      { id: "rock_jazz", choice: "a" },
      { id: "rock_more", choice: "a" },
    ]);
    expect(duelValue(bank, behind, duel)).toBe(0.5);
  });

  it("needs a full answer's worth of evidence (DUEL_MIN_SCORE) before a genre is a contender", () => {
    expect(DUEL_MIN_SCORE).toBe(1);
    const half = foldProfile(bank, [{ id: "rock_half_jazz", choice: "a" }]);
    expect(duelValue(bank, half, duel)).toBe(0);
  });

  it("multiplies the score by 1 + duel · value, from DEFAULT_DUEL_FROM on", () => {
    const tied = foldProfile(bank, [{ id: "rock_jazz", choice: "a" }]);
    const plain = scoreQuestion(bank, tied, duel, { duel: 0 });
    expect(scoreQuestion(bank, tied, duel)).toBeCloseTo(plain * (1 + DEFAULT_DUEL));
    expect(DEFAULT_DUEL_FROM).toBeGreaterThan(3);
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
