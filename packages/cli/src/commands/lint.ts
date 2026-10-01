import { formatDiagnostic, loadBank } from "@abtune/bank";
import { readBankFiles } from "@abtune/bank/node";

export const lintHelp = `abtune lint [files or globs...]

Validate question bank YAML against the schema and authoring rules (HANDOFF §8.4).
Defaults to data/questions/*.yaml. Community packs must be linted together with
the seed, which defines the dimensions. Exits 1 if there are errors.`;

export async function lint(args: readonly string[]): Promise<number> {
  const files = await readBankFiles(args);
  if (files.length === 0) {
    console.error("abtune lint: no files matched.");
    return 1;
  }
  const result = loadBank(files);
  for (const d of result.diagnostics) console.log(formatDiagnostic(d));
  const questions = result.bank?.questions.length ?? 0;
  const summary = `${files.length} file(s), ${questions} questions: ${result.errors} error(s), ${result.warnings} warning(s)`;
  console.log(result.errors > 0 ? `✗ ${summary}` : `✓ ${summary}`);
  return result.errors > 0 ? 1 : 0;
}
