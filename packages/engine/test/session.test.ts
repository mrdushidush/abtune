import { describe, expect, it } from "vitest";
import {
  createSession,
  defaultPacks,
  reduceSession,
  SessionError,
  type SessionState,
  sessionSeed,
  validateLog,
  viewSession,
} from "../src/index.ts";
import { makeBank, q } from "./fixtures.ts";

const questions = Array.from({ length: 6 }, (_, i) =>
  q(`q${i}`, "core", 90 - i, { energy: 1, rock: 1 }, { energy: -1, pop: 1 }),
);
const bank = makeBank(questions);
const answer = (s: SessionState, choice: "a" | "b" | "both" | "skip", id?: string) =>
  reduceSession(bank, s, { type: "answer", choice, ...(id ? { id } : {}) });

describe("createSession", () => {
  it("defaults to default packs (opt-in excluded), mode 20, length 50", () => {
    expect(defaultPacks(bank)).toEqual(["context", "core", "deep", "vibe"]);
    expect(createSession(bank)).toEqual({
      config: { mode: 20, length: 50, packs: ["context", "core", "deep", "vibe"], ai: false },
      answer_log: [],
      seed_salt: 0,
    });
  });

  it("sorts and dedupes packs, rejects unknown ones", () => {
    expect(createSession(bank, { packs: ["vibe", "core", "core"] }).config.packs).toEqual([
      "core",
      "vibe",
    ]);
    expect(() => createSession(bank, { packs: ["nope"] })).toThrow(SessionError);
  });
});

describe("reduceSession (HANDOFF §8.1)", () => {
  it("asks, answers, and becomes profile_ready at the mode", () => {
    let s = createSession(bank, { mode: 2, packs: ["core"] });
    expect(viewSession(bank, s)).toMatchObject({ status: "asking", position: 1, answered: 0 });
    s = answer(s, "a");
    s = answer(s, "b");
    const v = viewSession(bank, s);
    expect(v).toMatchObject({ status: "profile_ready", answered: 2, question: null });
    expect(() => answer(s, "a")).toThrow(/profile_ready/);
  });

  it("does not count skips toward the mode", () => {
    let s = createSession(bank, { mode: 2, packs: ["core"] });
    s = answer(s, "skip");
    expect(viewSession(bank, s)).toMatchObject({ status: "asking", position: 1, answered: 0 });
    s = answer(s, "a");
    s = answer(s, "both");
    expect(viewSession(bank, s).status).toBe("profile_ready");
    expect(s.answer_log).toHaveLength(3);
  });

  it("rejects stale answers", () => {
    const s = createSession(bank, { packs: ["core"] });
    const current = viewSession(bank, s).question?.id ?? "";
    expect(() => answer(s, "a", "q5")).toThrow(/Stale/);
    expect(answer(s, "a", current).answer_log).toEqual([{ id: current, choice: "a" }]);
  });

  it("back pops the last event, skips included, and refolds", () => {
    const s0 = createSession(bank, { packs: ["core"] });
    const s1 = answer(s0, "a");
    const s2 = answer(s1, "skip");
    expect(reduceSession(bank, s2, { type: "back" })).toEqual(s1);
    expect(viewSession(bank, reduceSession(bank, s1, { type: "back" }))).toEqual(
      viewSession(bank, s0),
    );
    expect(reduceSession(bank, s0, { type: "back" })).toBe(s0);
  });

  it("10 more raises the mode and keeps asking; not allowed mid-quiz", () => {
    let s = createSession(bank, { mode: 1, packs: ["core"] });
    expect(() => reduceSession(bank, s, { type: "ten_more" })).toThrow(/still asking/);
    s = answer(s, "a");
    s = reduceSession(bank, s, { type: "ten_more" });
    expect(s.config.mode).toBe(11);
    expect(viewSession(bank, s)).toMatchObject({ status: "asking", position: 2 });
  });

  it("reports exhaustion when the bank runs out before the mode", () => {
    let s = createSession(bank, { mode: 10, packs: ["core"] });
    for (let i = 0; i < 6; i++) s = answer(s, "a");
    expect(viewSession(bank, s)).toMatchObject({
      status: "exhausted",
      answered: 6,
      question: null,
    });
  });
});

describe("seeds", () => {
  it("are 64-bit hex, change with reshuffle and catalog, ignore pack order", () => {
    const s = answer(createSession(bank, { packs: ["core", "vibe"] }), "a");
    const seed = sessionSeed(bank, s, "cat-1");
    expect(seed).toMatch(/^[0-9a-f]{16}$/);
    expect(sessionSeed(bank, s, "cat-1")).toBe(seed);
    expect(sessionSeed(bank, s, "cat-2")).not.toBe(seed);
    expect(sessionSeed(bank, reduceSession(bank, s, { type: "reshuffle" }), "cat-1")).not.toBe(
      seed,
    );
    const reordered = { ...s, config: { ...s.config, packs: ["vibe", "core"] } };
    expect(sessionSeed(bank, reordered, "cat-1")).toBe(seed);
  });
});

describe("validateLog", () => {
  it("rejects unknown ids, repeats and bad choices", () => {
    expect(() => validateLog(bank, [{ id: "zz", choice: "a" }])).toThrow(/Unknown/);
    expect(() =>
      validateLog(bank, [
        { id: "q0", choice: "a" },
        { id: "q0", choice: "b" },
      ]),
    ).toThrow(/twice/);
    expect(() => validateLog(bank, [{ id: "q0", choice: "maybe" as "a" }])).toThrow(
      /Invalid choice/,
    );
    expect(() => validateLog(bank, [{ id: "q0", choice: "both" }])).not.toThrow();
  });
});
