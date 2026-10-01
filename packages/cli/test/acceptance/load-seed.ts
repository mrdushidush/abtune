import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { Bank } from "@abtune/engine";

export const QUESTIONS_DIR = fileURLToPath(new URL("../../../../data/questions", import.meta.url));
/** A frozen copy of the seed, so pinned digests don't move when the live bank grows. */
export const FROZEN_BANK_DIR = fileURLToPath(new URL("../fixtures/frozen-bank", import.meta.url));

/** The real question bank (seed + any community packs) as the app loads it, or another bank dir. */
export async function loadSeedBank(dir = QUESTIONS_DIR): Promise<Bank> {
  const result = await loadBankFromDisk(["*.yaml"], { cwd: dir });
  if (!result.bank || result.errors > 0) throw new Error("question bank does not lint clean");
  return result.bank;
}
