import { parseArgs } from "node:util";
import { loadBankFromDisk } from "@abtune/bank/node";
import { defaultPacks, SPICY_PACK } from "@abtune/engine";
import { ANSWER_MIXES, type AnswerMix, runQuiz, simulate } from "../sim.ts";

export const simHelp = `abtune sim [--runs N] [--seed HEX16] [--spicy]

Simulate quizzes against the question bank: prints the deterministic always-A and
always-B sequences (HANDOFF §16 #12), then random-answer statistics for
bank exhaustion (100-question mode) and coverage (10-question mode, §16 #6).`;

export async function sim(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      runs: { type: "string", default: "1000" },
      seed: { type: "string", default: "0123456789abcdef" },
      spicy: { type: "boolean", default: false },
    },
  });
  const result = await loadBankFromDisk();
  if (!result.bank || result.errors > 0) {
    console.error("abtune sim: the bank has errors; run `abtune lint`.");
    return 1;
  }
  const bank = result.bank;
  const packs = values.spicy ? [...defaultPacks(bank), SPICY_PACK] : defaultPacks(bank);
  const runs = Number(values.runs);

  console.log(`Packs: ${packs.join(", ")}\n`);
  for (const side of ["a", "b"] as const) {
    const run = runQuiz(bank, { mode: 10, packs }, () => side);
    console.log(`Always ${side.toUpperCase()}: ${run.sequence.join(", ")}`);
  }

  console.log(`\n${runs} random runs per row, seed ${values.seed}:\n`);
  console.log("| answers | mode | ended early | min answered | coverage §16 #6 |");
  console.log("|---|---|---|---|---|");
  for (const mode of [10, 100]) {
    for (const mix of Object.keys(ANSWER_MIXES) as AnswerMix[]) {
      const s = simulate(bank, { runs, mode, mix, seed: values.seed, packs });
      const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
      console.log(
        `| ${mix} | ${mode} | ${pct(s.exhaustedRate)} | ${s.minAnswered} | ${mode === 10 ? pct(s.coverageRate) : "–"} |`,
      );
    }
  }
  return 0;
}
