#!/usr/bin/env node
import { catalog, catalogHelp } from "./commands/catalog.ts";
import { evalCmd, evalHelp } from "./commands/eval.ts";
import { generate, generateHelp } from "./commands/generate.ts";
import { lint, lintHelp } from "./commands/lint.ts";
import { schema, schemaHelp } from "./commands/schema.ts";
import { sim, simHelp } from "./commands/sim.ts";
import { CliError } from "./context.ts";

type Command = { run: (args: readonly string[]) => Promise<number>; help: string };

const commands: Record<string, Command> = {
  catalog: { run: catalog, help: catalogHelp },
  eval: { run: evalCmd, help: evalHelp },
  generate: { run: generate, help: generateHelp },
  lint: { run: lint, help: lintHelp },
  schema: { run: schema, help: schemaHelp },
  sim: { run: sim, help: simHelp },
};

const usage = `abtune <command> [options]

Commands:
${Object.entries(commands)
  .map(([name, c]) => `  ${name.padEnd(8)} ${c.help.split("\n")[2] ?? ""}`)
  .join("\n")}

Run \`abtune <command> --help\` for details.`;

async function main(argv: readonly string[]): Promise<number> {
  const [name, ...rest] = argv;
  if (name === undefined || name === "--help" || name === "-h") {
    console.log(usage);
    return name === undefined ? 1 : 0;
  }
  const command = commands[name];
  if (!command) {
    console.error(`Unknown command "${name}".\n\n${usage}`);
    return 1;
  }
  if (rest.includes("--help") || rest.includes("-h")) {
    console.log(command.help);
    return 0;
  }
  try {
    return await command.run(rest);
  } catch (err) {
    if (!(err instanceof CliError)) throw err;
    console.error(`abtune ${name}: ${err.message}`);
    return 1;
  }
}

process.exitCode = await main(process.argv.slice(2));
