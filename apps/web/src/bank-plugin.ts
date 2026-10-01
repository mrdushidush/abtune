import path from "node:path";
import { formatDiagnostic } from "@abtune/bank";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { Plugin } from "vite";

const ID = "virtual:abtune-bank";
const RESOLVED = `\0${ID}`;

/**
 * Compiles data/questions/*.yaml into the client bundle as `virtual:abtune-bank`.
 * Lint errors fail the build, so a broken pack can never ship.
 */
export function abtuneBank(questionsDir: string): Plugin {
  return {
    name: "abtune-bank",
    resolveId(id) {
      return id === ID ? RESOLVED : undefined;
    },
    async load(id) {
      if (id !== RESOLVED) return undefined;
      const result = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
      for (const f of result.files) this.addWatchFile(path.join(questionsDir, f.path));
      if (!result.bank || result.errors > 0) {
        const lines = result.diagnostics.map(formatDiagnostic).join("\n");
        this.error(`Question bank has lint errors:\n${lines}`);
      }
      return `export default ${JSON.stringify(result.bank)};`;
    },
  };
}
