// Engine acceptance tests against the real seed bank (HANDOFF §16 #2, #6, #12).
// They live in the CLI package because they need the bank loader and the simulator.
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  type Bank,
  type Choice,
  createSession,
  defaultPacks,
  reduceSession,
  type SessionState,
  SPICY_PACK,
  viewSession,
} from "@abtune/engine";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { type AnswerMix, runQuiz, simulate } from "../../src/sim.ts";
import { determinismDigest } from "./determinism-worker.ts";
import { FROZEN_BANK_DIR, loadSeedBank } from "./load-seed.ts";

let bank: Bank;
beforeAll(async () => {
  bank = await loadSeedBank();
});

describe("§16 #12 golden selection sequences (default packs, spicy off)", () => {
  // If you change the selection rules on purpose, update these, HANDOFF §16 #12 and DECISIONS.md.
  const GOLDEN = {
    a: "bonjovi_britney, dancefloor_carcry, classical_edm, gym_yoga, english_world, heavy_smooth, hits_gems, scifi_romance, fresh_timeless, adele_dualipa",
    b: "bonjovi_britney, heavy_smooth, classical_edm, scifi_romance, bubblegum_artpop, english_world, dancefloor_carcry, matrix_titanic, fresh_timeless, adele_dualipa",
  };

  it.each(["a", "b"] as const)("always answering %s", (side) => {
    const run = runQuiz(bank, { mode: 10, packs: defaultPacks(bank) }, () => side);
    expect(run.sequence.join(", ")).toBe(GOLDEN[side]);
    expect(run.view.status).toBe("profile_ready");
  });
});

describe("§16 #6 coverage of random 10-question runs", () => {
  it.each(["ab", "ab+both", "ab+both+skip"] as AnswerMix[])("%s answers: ≥95% of runs", (mix) => {
    const stats = simulate(bank, { runs: 1000, mode: 10, mix, seed: "c0ffee00c0ffee00" });
    expect(stats.coverageRate).toBeGreaterThanOrEqual(0.95);
  });
});

describe("§16 #2 determinism across processes", () => {
  it("1,000 random sessions give byte-identical results in separate processes", async () => {
    const worker = fileURLToPath(new URL("./determinism-worker.ts", import.meta.url));
    const run = () =>
      promisify(execFile)(process.execPath, [worker, "1000", "5eed5eed5eed5eed"], {
        maxBuffer: 1 << 20,
      }).then((r) => r.stdout);
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(await determinismDigest(1000, "5eed5eed5eed5eed")).toBe(first);
  }, 180_000);

  it("is identical on every machine (pinned digest over a frozen bank; CI runs Linux, Windows, macOS)", async () => {
    // Changes only if the engine's behavior changes. If that's intended, update and log it in DECISIONS.md.
    expect(await determinismDigest(300, "a11ce5ba5eba11ed", FROZEN_BANK_DIR)).toBe(
      "3a8f5a73c2f753c13fb19dc4bb582ef86143032e67334477d55ba28154dc45a6",
    );
  }, 120_000);
});

describe("session properties", () => {
  const choiceArb = fc.constantFrom<Choice>("a", "b", "both", "skip");

  function play(state: SessionState, choices: readonly Choice[]): SessionState {
    let s = state;
    for (const choice of choices) {
      if (viewSession(bank, s).status !== "asking") break;
      s = reduceSession(bank, s, { type: "answer", choice });
    }
    return s;
  }

  it("back ≡ replaying the shorter log", () => {
    fc.assert(
      fc.property(fc.array(choiceArb, { maxLength: 40 }), fc.nat(40), (choices, k) => {
        const full = play(createSession(bank, { mode: 50 }), choices);
        let backed = full;
        const steps = Math.min(k, full.answer_log.length);
        for (let i = 0; i < steps; i++) backed = reduceSession(bank, backed, { type: "back" });
        const replayed = play(
          createSession(bank, { mode: 50 }),
          full.answer_log.slice(0, full.answer_log.length - steps).map((e) => e.choice),
        );
        expect(backed).toEqual(replayed);
        expect(viewSession(bank, backed)).toEqual(viewSession(bank, replayed));
      }),
      { numRuns: 200 },
    );
  });

  it("'10 more' after mode 10 ≡ a mode-20 session with the same answers", () => {
    fc.assert(
      fc.property(
        fc.array(choiceArb, { minLength: 30, maxLength: 30 }),
        fc.boolean(),
        (choices, spicy) => {
          const packs = spicy ? [...defaultPacks(bank), SPICY_PACK] : defaultPacks(bank);
          let s10 = play(createSession(bank, { mode: 10, packs }), choices);
          const used = s10.answer_log.length;
          if (viewSession(bank, s10).status !== "profile_ready") return;
          s10 = reduceSession(bank, s10, { type: "ten_more" });
          s10 = play(s10, choices.slice(used));
          const s20 = play(createSession(bank, { mode: 20, packs }), choices);
          expect(s10.answer_log).toEqual(s20.answer_log);
          expect(viewSession(bank, s10)).toEqual(viewSession(bank, s20));
        },
      ),
      { numRuns: 100 },
    );
  });

  it("never asks a question twice, never asks a disabled pack, stops at the mode", () => {
    fc.assert(
      fc.property(
        fc.array(choiceArb, { maxLength: 160 }),
        fc.constantFrom(10, 20, 50, 100),
        (choices, mode) => {
          const s = play(createSession(bank, { mode }), [...choices, ...Array(200).fill("a")]);
          const ids = s.answer_log.map((e) => e.id);
          expect(new Set(ids).size).toBe(ids.length);
          const packs = new Set(s.config.packs);
          for (const id of ids)
            expect(packs.has(bank.questions.find((x) => x.id === id)?.pack ?? "")).toBe(true);
          const v = viewSession(bank, s);
          expect(v.answered).toBeLessThanOrEqual(mode);
          if (v.status === "profile_ready") expect(v.answered).toBe(mode);
        },
      ),
      { numRuns: 100 },
    );
  });
});
