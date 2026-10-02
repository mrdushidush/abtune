// Generates playlists for N randomized sessions on the committed fixture and prints one digest
// over the ordered track ids. Run in separate processes by the §16 #2 playlist test.
import { FIXTURE_DIR } from "@abtune/catalog";
import { loadCatalog } from "@abtune/catalog/reader";
import { canonicalJson, createRng, generate, sha256Hex, tasteVector } from "@abtune/engine";
import { randomSessionTrace } from "../../src/sim.ts";
import { loadSeedBank } from "./load-seed.ts";

export async function playlistDigest(
  count: number,
  masterSeed: string,
  bankDir?: string,
): Promise<string> {
  const bank = await loadSeedBank(bankDir);
  const catalog = await loadCatalog(FIXTURE_DIR, bank.dimensions);
  try {
    const rng = createRng(masterSeed);
    const lines: string[] = [];
    for (let i = 0; i < count; i++) {
      const trace = randomSessionTrace(bank, rng, catalog.columns.version);
      const out = generate(catalog.columns, tasteVector(bank, trace.profile), {
        length: trace.config.length,
        seed: trace.seed,
      });
      lines.push(
        canonicalJson({
          seed: trace.seed,
          tracks: out.tracks.map((t) => catalog.trackId(t.index)),
          warnings: out.warnings,
        }),
      );
    }
    return sha256Hex(lines.join("\n"));
  } finally {
    catalog.close();
  }
}

if (process.argv[1] && import.meta.filename === process.argv[1]) {
  const [count = "1000", seed = "5eed5eed5eed5eed"] = process.argv.slice(2);
  process.stdout.write(await playlistDigest(Number(count), seed));
}
