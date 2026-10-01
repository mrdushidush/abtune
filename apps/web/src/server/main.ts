import path from "node:path";
import { formatDiagnostic } from "@abtune/bank";
import { loadBankFromDisk } from "@abtune/bank/node";
import { serve } from "@hono/node-server";
import pkg from "../../package.json" with { type: "json" };
import { createApp } from "./app.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
const questionsDir = process.env.QUESTIONS_DIR ?? path.join(repoRoot, "data/questions");
const staticDir = process.env.STATIC_DIR ?? path.resolve(import.meta.dirname, "../../dist/client");
const port = Number(process.env.PORT ?? 8787);
const hostname = process.env.HOST ?? "127.0.0.1";

const result = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
if (!result.bank || result.errors > 0) {
  for (const d of result.diagnostics) console.error(formatDiagnostic(d));
  console.error(`Question bank in ${questionsDir} has errors; refusing to start.`);
  process.exit(1);
}

const app = createApp({
  bank: result.bank,
  version: pkg.version,
  staticRoot: path.relative(process.cwd(), staticDir) || ".",
});

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    `ABTune ${pkg.version} on http://${info.address}:${info.port} (${result.bank?.questions.length} questions)`,
  );
});
