import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import { engineVersion, playlistTitle, tasteVector } from "@abtune/engine";
import {
  catalogBaseline,
  DEFAULT_EVAL,
  type EvalSettings,
  evaluateQuizzes,
  FIT_MARGIN,
  fitTables,
  loadPersonas,
  PERSONAS_DIR,
  type PrintedPlaylist,
  percentile,
  randomPlaylists,
  renderReport,
  reportOrder,
  runPersonaQuizzes,
  summarize,
  TUNE_SPACE,
  tune,
} from "@abtune/eval";
import { loadBank, openCatalog } from "../context.ts";

export const evalHelp = `abtune eval [options]

Persona eval (HANDOFF §17) and the §16 #3–#5 checks: each persona answers the quiz at every
mode, playlists are generated and scored, random listeners check §9.3 and timing.

  --catalog <dir>   catalog directory (default: CATALOG_PATH or the best under data/catalog)
  --salts <n>       playlists per persona and mode (default 5)
  --noise <p>       also report with this share of answers flipped (default 0.15; 0 = off)
  --random <n>      random-listener playlists for §9.3 and timing (default 1000)
  --tune            coordinate-search the weights first (slow), and report with the result
  --tune-salts <n>  playlists per persona and mode while tuning (default 2)
  --out <file>      write the markdown report (default for a full catalog: docs/eval/<date>.md)

Exits non-zero if a §16 #3–#5 check fails.`;

const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

export async function evalCmd(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      catalog: { type: "string" },
      salts: { type: "string", default: "5" },
      noise: { type: "string", default: "0.15" },
      random: { type: "string", default: "1000" },
      tune: { type: "boolean", default: false },
      "tune-salts": { type: "string", default: "2" },
      out: { type: "string" },
    },
  });
  const bank = await loadBank();
  const personas = await loadPersonas(path.resolve(PERSONAS_DIR), bank.dimensions);
  const catalog = await openCatalog(bank, values.catalog);
  const columns = catalog.columns;
  log(
    `${columns.version} (${catalog.manifest.kind}, ${columns.n} tracks) loaded in ${(catalog.loadMs / 1000).toFixed(1)} s; ${personas.length} personas`,
  );
  try {
    let settings: EvalSettings = { ...DEFAULT_EVAL, salts: Number(values.salts) };
    let tuning:
      | { start: ReturnType<typeof summarize>; changes: string[]; evaluations: number }
      | undefined;
    if (values.tune) {
      const result = tune(
        bank,
        columns,
        personas,
        { ...settings, salts: Number(values["tune-salts"]) },
        { log },
      );
      const changes = TUNE_SPACE.filter((d) => d.get(result.settings) !== d.get(settings)).map(
        (d) => `${d.name}: ${d.get(settings)} → ${d.get(result.settings)}`,
      );
      for (const c of changes) log(`tuned ${c}`);
      settings = { ...result.settings, salts: settings.salts };
      tuning = { start: result.start, changes, evaluations: result.steps.length + 1 };
    }

    log("persona playlists…");
    const quizzes = runPersonaQuizzes(bank, personas, settings);
    const results = evaluateQuizzes(bank, columns, quizzes, settings);
    const summary = summarize(results);
    for (const m of summary.byMode)
      log(`mode ${m.mode}: fit ${m.metrics.fit.toFixed(4)}, violations ${m.violations}`);

    const noise = Number(values.noise);
    let noisy: { noise: number; summary: ReturnType<typeof summarize> } | undefined;
    if (noise > 0) {
      const ns = { ...settings, noise };
      noisy = {
        noise,
        summary: summarize(
          evaluateQuizzes(bank, columns, runPersonaQuizzes(bank, personas, ns), ns),
        ),
      };
      log(
        `noise ${noise}: ${noisy.summary.byMode.map((m) => m.metrics.fit.toFixed(4)).join(" → ")}`,
      );
    }

    const baselines = new Map(
      personas.map((p) => [p.id, catalogBaseline(columns, fitTables(columns, p))]),
    );
    log(`random listeners (${values.random})…`);
    const random = randomPlaylists(
      bank,
      columns,
      Number(values.random),
      "e7a1e7a1e7a1e7a1",
      settings,
    );
    const p95 = percentile(random.ms50, 0.95);
    log(`random: ${random.violations} violations, ${random.short} short, p95 ${p95.toFixed(0)} ms`);

    const printed: PrintedPlaylist[] = [];
    const showMode = settings.modes.includes(50) ? 50 : (settings.modes.at(-1) as number);
    for (const p of reportOrder(personas)) {
      const row = results.find((r) => r.persona.id === p.id && r.mode === showMode);
      const quiz = quizzes.find((q) => q.persona.id === p.id && q.mode === showMode);
      const playlist = row?.playlists[0];
      if (!row || !quiz || !playlist) continue;
      const meta = await catalog.meta(playlist.tracks);
      const taste = tasteVector(bank, quiz.view.profile, settings.taste);
      printed.push({
        persona: p,
        mode: showMode,
        title: playlistTitle(bank.dimensions, taste, quiz.view.answered, playlist.seed).title,
        lines: meta.map(
          (m) =>
            `${m.artist_credit} — ${m.title} (${m.year ?? "?"}) · ${m.primary_cluster ?? "no cluster"} · ${m.language}`,
        ),
      });
    }

    const violations = random.violations + summary.byMode.reduce((a, m) => a + m.violations, 0);
    const full = catalog.manifest.kind === "full";
    const date = new Date().toLocaleDateString("en-CA"); // YYYY-MM-DD, local time
    const report = renderReport({
      date,
      catalog: {
        version: columns.version,
        kind: catalog.manifest.kind,
        tracks: columns.n,
        loadMs: catalog.loadMs,
      },
      engineVersion: engineVersion(bank),
      settings,
      results,
      summary,
      ...(noisy ? { noisy } : {}),
      baselines,
      random,
      printed,
      marginThreshold: FIT_MARGIN,
      ...(tuning ? { tuning } : {}),
      notes: full
        ? [
            "Catalog gap (owner decision: catalog frozen for M3): only 1,825 tracks carry the `mizrahi` cluster, and 8,281 of 18,000 Hebrew-language tracks have no cluster at all, so the Hebrew-mizrahi persona's cluster fit is capped by the data, not the generator.",
          ]
        : [],
    });
    const out = values.out ?? (full ? path.join("docs/eval", `${date}.md`) : undefined);
    if (out) {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, report);
      log(`wrote ${out}`);
    }
    const ok =
      violations === 0 && summary.monotone && summary.margin >= FIT_MARGIN && (!full || p95 < 2000);
    log(ok ? "§16 #3–#5: pass" : "§16 #3–#5: FAIL");
    return ok ? 0 : 1;
  } finally {
    catalog.close();
  }
}
