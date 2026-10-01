import { readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { bankFileJsonSchema } from "@abtune/bank";
import { loadBankFromDisk } from "@abtune/bank/node";

export const schemaHelp = `abtune schema [--out <file>] [--check]

Generate the JSON Schema that gives editors autocomplete for question bank YAML
(fx keys come from the seed's dimensions). --check exits 1 if <file> is stale.`;

export async function schema(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: { out: { type: "string" }, check: { type: "boolean", default: false } },
  });
  const result = await loadBankFromDisk();
  if (!result.bank) {
    console.error("abtune schema: the bank does not load; run `abtune lint` first.");
    return 1;
  }
  const json = `${JSON.stringify(bankFileJsonSchema(result.bank.dimensions), null, 2)}\n`;
  if (!values.out) {
    process.stdout.write(json);
    return 0;
  }
  if (values.check) {
    const current = await readFile(values.out, "utf8").catch(() => "");
    if (current.replaceAll("\r\n", "\n") !== json) {
      console.error(`${values.out} is stale. Run \`pnpm schema\` and commit the result.`);
      return 1;
    }
    console.log(`✓ ${values.out} is up to date`);
    return 0;
  }
  await writeFile(values.out, json);
  console.log(`wrote ${values.out}`);
  return 0;
}
