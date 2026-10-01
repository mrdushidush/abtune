// Node-only helpers (filesystem). Kept out of the main entry so browser bundles never see node:fs.
import { glob, readFile } from "node:fs/promises";
import path from "node:path";
import { type BankSourceFile, type LoadResult, loadBank } from "./index.ts";
import type { LintOptions } from "./lint.ts";

export const DEFAULT_BANK_GLOB = "data/questions/*.yaml";

export interface ReadOptions {
  /** Directory that patterns (and the reported paths) are relative to. Defaults to process.cwd(). */
  readonly cwd?: string;
}

/** Read bank YAML files matching `patterns`, sorted so merges are deterministic. */
export async function readBankFiles(
  patterns: readonly string[],
  { cwd = process.cwd() }: ReadOptions = {},
): Promise<BankSourceFile[]> {
  const found = new Set<string>();
  for (const pattern of patterns.length > 0 ? patterns : [DEFAULT_BANK_GLOB]) {
    for await (const match of glob(pattern, { cwd })) found.add(match.split(path.sep).join("/"));
  }
  const paths = [...found].sort();
  return Promise.all(
    paths.map(async (p) => ({ path: p, text: await readFile(path.resolve(cwd, p), "utf8") })),
  );
}

export async function loadBankFromDisk(
  patterns: readonly string[] = [],
  options: ReadOptions & { lint?: LintOptions } = {},
): Promise<LoadResult & { files: readonly BankSourceFile[] }> {
  const files = await readBankFiles(patterns, options);
  return { ...loadBank(files, options.lint), files };
}
