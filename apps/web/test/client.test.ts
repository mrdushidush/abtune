// Client logic that doesn't need a DOM: the playlist request (privacy), persistence, gestures, hints.
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import {
  type Bank,
  type Choice,
  engineVersion,
  hintKey,
  type SessionState,
  viewSession,
} from "@abtune/engine";
import { describe, expect, it } from "vitest";
import { liveHint } from "../src/client/lib/hints.ts";
import { dragProgress, isDrag, swipeDecision } from "../src/client/lib/swipe.ts";
import { buildPlaylistRequest } from "../src/client/state/api.ts";
import {
  type AppState,
  appReducer,
  EMPTY_STATE,
  randomQuizSeed,
  restoreState,
  STORAGE_KEY,
  screenOf,
} from "../src/client/state/app.ts";

const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));
const { bank: loaded } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
if (!loaded) throw new Error("seed bank failed to load");
const bank: Bank = loaded;

/** Play a whole quiz through the app reducer, cycling the given choices. */
function play(
  choices: readonly Choice[],
  mode = 20,
  packs = ["context", "core", "deep", "spicy", "vibe"],
) {
  let s: AppState = appReducer(bank, EMPTY_STATE, {
    type: "start",
    setup: { mode, length: 50, packs },
    quizSeed: "5eed00005eed0000",
  });
  let i = 0;
  while (screenOf(bank, s) === "quiz") {
    s = appReducer(bank, s, {
      type: "session",
      action: { type: "answer", choice: choices[i++ % choices.length] as Choice },
    });
  }
  return s;
}

describe("playlist request", () => {
  it("never carries answers, so sensitive ones stay on the device (HANDOFF §13, §16 #9)", () => {
    const s = play(["a", "b", "both", "a"], 50);
    const session = s.session as SessionState;
    const spicy = session.answer_log.filter(
      (e) => bank.questions.find((q) => q.id === e.id)?.sensitive,
    );
    expect(spicy.length).toBeGreaterThan(0);
    const body = JSON.stringify(
      buildPlaylistRequest(bank, session, { energy: 1 }, "catalog-2026.09"),
    );
    expect(Object.keys(JSON.parse(body)).sort()).toEqual([
      "catalog_version",
      "engine_version",
      "length",
      "seed",
      "taste",
    ]);
    for (const q of bank.questions) {
      expect(body).not.toContain(`"${q.id}"`);
      expect(body).not.toContain(q.a.label);
      expect(body).not.toContain(q.b.label);
    }
    expect(body).not.toMatch(/"(a|b|both|skip)"/);
  });

  it("has the same engine version as the server after the bank's trip through JSON", () => {
    // The Vite plugin ships the bank to the browser as JSON; seeds must not change on the way.
    const roundTripped = JSON.parse(JSON.stringify(bank)) as Bank;
    expect(engineVersion(roundTripped)).toBe(engineVersion(bank));
  });

  it("changes seed on reshuffle and taste on tweak", () => {
    const s = play(["a", "b"]);
    const req = buildPlaylistRequest(bank, s.session as SessionState, {}, "c");
    const shuffled = appReducer(bank, s, { type: "session", action: { type: "reshuffle" } });
    const req2 = buildPlaylistRequest(bank, shuffled.session as SessionState, {}, "c");
    expect(req2.seed).not.toBe(req.seed);
    expect(req2.taste).toEqual(req.taste);
    const tweaked = buildPlaylistRequest(bank, s.session as SessionState, { energy: 2 }, "c");
    expect(tweaked.seed).toBe(req.seed);
    expect(tweaked.taste).not.toEqual(req.taste);
  });
});

describe("app state", () => {
  it("walks setup → quiz → result → 10 more → quiz", () => {
    expect(screenOf(bank, EMPTY_STATE)).toBe("setup");
    const s = play(["a"], 10);
    expect(screenOf(bank, s)).toBe("result");
    const more = appReducer(bank, s, { type: "session", action: { type: "ten_more" } });
    expect(screenOf(bank, more)).toBe("quiz");
    const view = viewSession(bank, more.session as SessionState);
    expect([view.position, view.mode]).toEqual([11, 20]);
    const back = appReducer(bank, s, { type: "session", action: { type: "back" } });
    expect(screenOf(bank, back)).toBe("quiz");
  });

  it("ignores stale answers instead of crashing", () => {
    const s = play(["a"], 10);
    const after = appReducer(bank, s, { type: "session", action: { type: "answer", choice: "a" } });
    expect(after).toBe(s);
  });

  it("keeps tweaks within ±2 and clears them on restart", () => {
    let s = play(["b"], 10);
    for (let i = 0; i < 4; i++) s = appReducer(bank, s, { type: "tweak", id: "newer" });
    s = appReducer(bank, s, { type: "tweak", id: "calmer" });
    expect(s.tweaks).toEqual({ era: 2, energy: -1 });
    s = appReducer(bank, s, { type: "untweak", axis: "era" });
    expect(s.tweaks).toEqual({ energy: -1 });
    const restarted = appReducer(bank, s, { type: "restart" });
    expect(restarted).toEqual({
      ...EMPTY_STATE,
      setup: s.setup,
      recent: s.session?.answer_log.map((e) => e.id),
    });
  });

  it("varies the quiz between sessions: a new seed, avoiding the last session's variants", () => {
    const first = play(["a", "b"], 10);
    const restarted = appReducer(bank, first, { type: "restart" });
    const second = appReducer(bank, restarted, {
      type: "start",
      setup: first.setup as NonNullable<AppState["setup"]>,
      quizSeed: "0123456789abcdef",
    });
    expect(second.session?.config.quiz_seed).toBe("0123456789abcdef");
    expect(second.session?.config.avoid).toEqual(
      [...new Set(first.session?.answer_log.map((e) => e.id))].sort(),
    );
    expect(randomQuizSeed()).toMatch(/^[0-9a-f]{16}$/);
    expect(randomQuizSeed()).not.toBe(randomQuizSeed());
  });

  it("restores a saved session and drops anything unusable", () => {
    const s = play(["a", "b", "skip"], 10);
    const raw = JSON.stringify({ v: 1, engine_version: engineVersion(bank), state: s });
    expect(restoreState(bank, raw)).toEqual(s);
    expect(restoreState(bank, null)).toEqual(EMPTY_STATE);
    expect(restoreState(bank, "{not json")).toEqual(EMPTY_STATE);
    // Saved by another bank version, referencing a question that no longer exists.
    const session = s.session as SessionState;
    const gone = {
      ...s,
      session: {
        ...session,
        answer_log: [...session.answer_log, { id: "no_such_q", choice: "a" }],
      },
    };
    expect(
      restoreState(bank, JSON.stringify({ v: 1, engine_version: "old", state: gone })),
    ).toEqual(EMPTY_STATE);
    const badTweaks = { ...s, tweaks: { energy: 9 } };
    expect(
      restoreState(
        bank,
        JSON.stringify({ v: 1, engine_version: engineVersion(bank), state: badTweaks }),
      ).tweaks,
    ).toEqual({});
    expect(STORAGE_KEY).toMatch(/v1$/);
  });
});

describe("swipe", () => {
  it("commits past a quarter of the width or on a flick", () => {
    expect(swipeDecision(-100, 400, 360)).toBe("a");
    expect(swipeDecision(95, 400, 360)).toBe("b");
    expect(swipeDecision(60, 400, 360)).toBeNull();
    expect(swipeDecision(60, 50, 360)).toBe("b");
    expect(swipeDecision(30, 10, 360)).toBeNull();
  });

  it("tells drags from taps and scrolls", () => {
    expect(isDrag(4, 1)).toBe(false);
    expect(isDrag(14, 3)).toBe(true);
    expect(isDrag(14, 30)).toBe(false);
    expect(dragProgress(-500, 360)).toBe(-1);
    expect(dragProgress(45, 360)).toBe(0.5);
  });
});

describe("live hints", () => {
  it("start after the hook and follow Back", () => {
    const s = play(["a"], 20);
    const log = (s.session as SessionState).answer_log;
    expect(liveHint(bank, log.slice(0, 2))).toBeNull();
    const hints = Array.from({ length: log.length + 1 }, (_, k) => liveHint(bank, log.slice(0, k)));
    expect(hints.filter(Boolean).length).toBeGreaterThan(5);
    // Pure function of the log: the same prefix always gives the same hint.
    const k = 12;
    expect(liveHint(bank, log.slice(0, k))).toEqual(hints[k]);
    expect(new Set(hints.filter(Boolean).map((h) => hintKey(h as never))).size).toBeGreaterThan(1);
  });
});
