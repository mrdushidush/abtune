import type { Bank } from "@abtune/engine";
import { type LintOptions, lintBank } from "./lint.ts";
import {
  type Diagnostic,
  type MergedBank,
  mergeBankFiles,
  type ParsedFile,
  parseBankFile,
} from "./parse.ts";

export type { LintOptions } from "./lint.ts";
export { lintBank } from "./lint.ts";
export type { Diagnostic, MergedBank, ParsedFile, QuestionSource, Severity } from "./parse.ts";
export { locate, locateKey, mergeBankFiles, parseBankFile } from "./parse.ts";
export type { BankFileData } from "./schema.ts";
export { bankFileJsonSchema, bankFileSchema } from "./schema.ts";

export interface BankSourceFile {
  /** Path used in diagnostics (relative paths read best). */
  readonly path: string;
  readonly text: string;
}

export interface LoadResult {
  /** Present when every file parsed and merged; check `errors` before trusting it. */
  readonly bank?: Bank;
  readonly merged?: MergedBank;
  readonly diagnostics: readonly Diagnostic[];
  readonly errors: number;
  readonly warnings: number;
}

/** Parse, merge and lint a set of bank files. Pure: callers do the file IO. */
export function loadBank(files: readonly BankSourceFile[], options?: LintOptions): LoadResult {
  const diagnostics: Diagnostic[] = [];
  const parsed: ParsedFile[] = [];
  for (const f of files) {
    const r = parseBankFile(f.text, f.path);
    parsed.push(r.parsed);
    diagnostics.push(...r.diagnostics);
  }
  const { merged, diagnostics: mergeDiags } = mergeBankFiles(parsed);
  diagnostics.push(...mergeDiags);
  if (merged) diagnostics.push(...lintBank(merged, options));

  diagnostics.sort(
    (x, y) => cmp(x.file, y.file) || x.line - y.line || x.col - y.col || cmp(x.rule, y.rule),
  );
  const errors = diagnostics.filter((d) => d.severity === "error").length;
  return {
    ...(merged ? { bank: merged.bank, merged } : {}),
    diagnostics,
    errors,
    warnings: diagnostics.length - errors,
  };
}

/** `file:line:col severity rule message`, the format editors and CI annotate. */
export function formatDiagnostic(d: Diagnostic): string {
  return `${d.file}:${d.line}:${d.col} ${d.severity} [${d.rule}] ${d.message}`;
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
