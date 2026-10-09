import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { Bank } from "@abtune/engine";

export const QUESTIONS_DIR = fileURLToPath(new URL("../../../../data/questions", import.meta.url));
/** A frozen copy of the seed, so pinned digests don't move when the live bank grows. */
export const FROZEN_BANK_DIR = fileURLToPath(new URL("../fixtures/frozen-bank", import.meta.url));
/** The seed as of M3, for the §16 #12 goldens: they pin the selection rules, not the growing bank. */
export const M3_BANK_DIR = fileURLToPath(new URL("../fixtures/m3-bank", import.meta.url));

/**
 * The 1,000-session determinism tests run the engine three times (two processes at once, then in
 * process) next to the rest of the suite, so they take 2–3.5 minutes on CI runners. A limit near
 * that made them flaky on Windows; this one is a hang guard, not a speed check.
 */
export const DETERMINISM_TIMEOUT = 420_000;

/** The real question bank (seed + any community packs) as the app loads it, or another bank dir. */
export async function loadSeedBank(dir = QUESTIONS_DIR): Promise<Bank> {
  const result = await loadBankFromDisk(["*.yaml"], { cwd: dir });
  if (!result.bank || result.errors > 0) throw new Error("question bank does not lint clean");
  return result.bank;
}
