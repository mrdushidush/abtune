// Runs N randomized sessions from a master seed and prints one digest over all of them.
// The determinism test runs this in separate processes and compares digests (HANDOFF §16 #2).
import { canonicalJson, createRng, sha256Hex } from "@abtune/engine";
import { randomSessionTrace } from "../../src/sim.ts";
import { loadSeedBank } from "./load-seed.ts";

export async function determinismDigest(
  count: number,
  masterSeed: string,
  bankDir?: string,
): Promise<string> {
  const bank = await loadSeedBank(bankDir);
  const rng = createRng(masterSeed);
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    lines.push(canonicalJson(randomSessionTrace(bank, rng, "catalog-test")));
  }
  return sha256Hex(lines.join("\n"));
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [count = "1000", seed = "5eed5eed5eed5eed"] = process.argv.slice(2);
  process.stdout.write(await determinismDigest(Number(count), seed));
}
