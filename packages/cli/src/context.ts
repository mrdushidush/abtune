// Shared setup for commands that need the bank and an installed catalog.
import path from "node:path";
import { formatDiagnostic } from "@abtune/bank";
import { loadBankFromDisk } from "@abtune/bank/node";
import { findCatalog } from "@abtune/catalog";
import { type LoadedCatalog, loadCatalog } from "@abtune/catalog/reader";
import type { Bank } from "@abtune/engine";

export class CliError extends Error {
  override name = "CliError";
}

export async function loadBank(): Promise<Bank> {
  const result = await loadBankFromDisk();
  if (!result.bank || result.errors > 0) {
    for (const d of result.diagnostics) console.error(formatDiagnostic(d));
    throw new CliError("The question bank has errors; run `abtune lint`.");
  }
  return result.bank;
}

/** `dir`, else CATALOG_PATH, else the best catalog under data/catalog (full beats dev sample). */
export async function openCatalog(bank: Bank, dir?: string): Promise<LoadedCatalog> {
  const found = await findCatalog(
    path.resolve("data/catalog"),
    dir ?? (process.env.CATALOG_PATH || undefined),
  );
  if (!found) {
    throw new CliError(
      "No catalog installed. Run `abtune catalog fetch`, or pass --catalog <dir>.",
    );
  }
  return loadCatalog(found.dir, bank.dimensions);
}
