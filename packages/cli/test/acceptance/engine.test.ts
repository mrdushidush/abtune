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
import { FROZEN_BANK_DIR, loadSeedBank, M3_BANK_DIR } from "./load-seed.ts";

let bank: Bank;
let m3: Bank;
beforeAll(async () => {
  bank = await loadSeedBank();
  m3 = await loadSeedBank(M3_BANK_DIR);
});

describe("§16 #12 golden selection sequences (default packs, spicy off)", () => {
  // Over the seed as of M3 (frozen copy): the live bank grows, the selection rules don't.
  // If you change the selection rules on purpose, update these, HANDOFF §16 #12 and DECISIONS.md.
  // M3: IG normalized by key count after the 3-question hook (HANDOFF §18, chosen by the persona eval).
  // 2026-10-03: the genre-duel bonus (DEFAULT_DUEL) doesn't change these first 10.
  // 2026-10-04: explore slots (DEFAULT_EXPLORE) ask about an untouched genre or decade at 5 and 9.
  const GOLDEN = {
    a: "bonjovi_britney, dancefloor_carcry, classical_edm, horror_comedy, guitar_synth, hits_gems, fast_slow, rain_sun, fresh_timeless, english_world",
    b: "bonjovi_britney, heavy_smooth, classical_edm, horror_comedy, guitar_synth, hits_gems, simple_complex, rain_sun, fresh_timeless, dancefloor_carcry",
  };
  // §8.3 as written: the brief's original table, still reproduced with igNorm "none", no duel
  // bonus and no explore slots.
  const BRIEF = {
    a: "bonjovi_britney, dancefloor_carcry, classical_edm, gym_yoga, english_world, heavy_smooth, hits_gems, scifi_romance, fresh_timeless, adele_dualipa",
    b: "bonjovi_britney, heavy_smooth, classical_edm, scifi_romance, bubblegum_artpop, english_world, dancefloor_carcry, matrix_titanic, fresh_timeless, adele_dualipa",
  };

  it.each(["a", "b"] as const)("always answering %s", (side) => {
    const run = runQuiz(m3, { mode: 10, packs: defaultPacks(m3) }, () => side);
    expect(run.sequence.join(", ")).toBe(GOLDEN[side]);
    expect(run.view.status).toBe("profile_ready");
  });

  it.each(["a", "b"] as const)("always answering %s, §8.3 as written", (side) => {
    const literal = { igNorm: "none", duel: 0, explore: false } as const;
    const run = runQuiz(m3, { mode: 10, packs: defaultPacks(m3) }, () => side, literal);
    expect(run.sequence.join(", ")).toBe(BRIEF[side]);
  });
});

describe("the live bank (no quiz seed)", () => {
  // A snapshot, so a bank edit that changes what people are asked first shows up in review.
  it.each(["a", "b"] as const)("always answering %s", (side) => {
    const run = runQuiz(bank, { mode: 10, packs: defaultPacks(bank) }, () => side);
    expect(run.sequence).toMatchSnapshot();
  });
});

describe("variety (owner decision D7): a quiz seed per session", () => {
  const first10 = (seed: string, avoid: readonly string[] = []) =>
    runQuiz(bank, { mode: 10, packs: defaultPacks(bank), quiz_seed: seed, avoid }, (q) =>
      q.id.length % 2 ? "a" : "b",
    ).sequence;
  const shared = (x: readonly string[], y: readonly string[]) =>
    x.filter((id) => y.includes(id)).length;

  it("replays the same path for the same seed and answers", () => {
    expect(first10("00000000000000a1")).toEqual(first10("00000000000000a1"));
  });

  it("a retake that avoids the last session's cards shares few of the first 10", () => {
    let total = 0;
    const runs = 40;
    for (let k = 0; k < runs; k++) {
      const one = first10(`${k.toString(16).padStart(14, "0")}aa`);
      const two = first10(`${k.toString(16).padStart(14, "0")}bb`, one);
      total += shared(one, two);
    }
    expect(total / runs).toBeLessThan(4);
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
      "8ebfbb78e6da964f2b5b473932f37ef468d403eadab123671555bb6d403ed18f",
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
