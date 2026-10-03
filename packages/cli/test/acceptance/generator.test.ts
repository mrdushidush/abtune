// Generator acceptance tests on the committed 5k fixture (HANDOFF §16 #2, #4; §17 snapshots).
// The full-catalog numbers (§16 #3–#5) come from `abtune eval` and live in docs/eval/.
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { FIXTURE_DIR } from "@abtune/catalog";
import { type LoadedCatalog, loadCatalog } from "@abtune/catalog/reader";
import {
  type Bank,
  checkPlaylist,
  createRng,
  defaultPacks,
  generate,
  playlistTitle,
  runQuiz,
  sessionSeed,
  tasteVector,
} from "@abtune/engine";
import { fitTables, loadPersonas, personaAnswerer, playlistMetrics } from "@abtune/eval";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { randomSessionTrace } from "../../src/sim.ts";
import { FROZEN_BANK_DIR, loadSeedBank } from "./load-seed.ts";
import { playlistDigest } from "./playlist-worker.ts";

const REPO = fileURLToPath(new URL("../../../../", import.meta.url));

let bank: Bank;
let catalog: LoadedCatalog;
beforeAll(async () => {
  bank = await loadSeedBank();
  catalog = await loadCatalog(FIXTURE_DIR, bank.dimensions);
});
afterAll(() => catalog.close());

describe("§16 #4 constraints on the fixture", () => {
  it("1,000 random listeners at lengths 25/50/100 all satisfy §9.3", () => {
    const rng = createRng("c0a571a1c0a571a1");
    const lengths = [25, 50, 100];
    for (let i = 0; i < 1000; i++) {
      const trace = randomSessionTrace(bank, rng, catalog.columns.version);
      const length = lengths[i % 3] as number;
      const out = generate(catalog.columns, tasteVector(bank, trace.profile), {
        length,
        seed: trace.seed,
      });
      expect(out.warnings).not.toContain("catalog_exhausted");
      expect(
        checkPlaylist(
          catalog.columns,
          out.tracks.map((t) => t.index),
          length,
        ),
      ).toEqual([]);
    }
    // ~50 s alone; the full suite runs it next to other catalog-loading tests.
  }, 180_000);
});

describe("§16 #2 playlist determinism", () => {
  it("1,000 random sessions give byte-identical playlists in separate processes", async () => {
    const worker = fileURLToPath(new URL("./playlist-worker.ts", import.meta.url));
    const run = () =>
      promisify(execFile)(process.execPath, [worker, "1000", "5eed5eed5eed5eed"], {
        maxBuffer: 1 << 20,
      }).then((r) => r.stdout);
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(second).toBe(first);
    expect(await playlistDigest(1000, "5eed5eed5eed5eed")).toBe(first);
  }, 180_000);

  it("is identical on every machine (pinned digest: frozen bank + fixture; CI runs Linux, Windows, macOS)", async () => {
    // Changes only if generation changes. If that's intended, update and log it in DECISIONS.md.
    expect(await playlistDigest(300, "a11ce5ba5eba11ed", FROZEN_BANK_DIR)).toBe(
      "9e9ef55e6af3078fad74299e64200b6b137ec1363f6fb721513b1fa948b93295",
    );
  }, 120_000);
});

describe("§17 persona snapshots (regression guard)", () => {
  it.each(["hebrew_rock_pop", "eighties_pop", "metalhead_2000s"])(
    "%s, 20 questions",
    async (id) => {
      const personas = await loadPersonas(path.join(REPO, "data/personas"), bank.dimensions);
      const persona = personas.find((p) => p.id === id);
      if (!persona) throw new Error(`no persona ${id}`);
      const run = runQuiz(
        bank,
        { mode: 20, length: 25, packs: defaultPacks(bank) },
        personaAnswerer(bank, persona),
      );
      const taste = tasteVector(bank, run.view.profile);
      const seed = sessionSeed(bank, run.state, catalog.columns.version);
      const out = generate(catalog.columns, taste, { length: 25, seed });
      const tracks = out.tracks.map((t) => t.index);
      const metrics = playlistMetrics(catalog.columns, fitTables(catalog.columns, persona), tracks);
      // Intended changes to the bank, taste or generator params update these: `vitest -u`.
      expect({
        answers: run.state.answer_log.map((e) => `${e.id}=${e.choice}`),
        title: playlistTitle(bank.dimensions, taste, run.view.answered, seed).title,
        fit: Number(metrics.fit.toFixed(4)),
        tracks: tracks.map((i) => catalog.trackId(i)),
      }).toMatchSnapshot();
    },
  );
});
