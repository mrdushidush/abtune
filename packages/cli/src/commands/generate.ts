import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type AnswerEvent,
  createSession,
  defaultPacks,
  engineVersion,
  generate as generatePlaylist,
  playlistTitle,
  runQuiz,
  type SessionState,
  sessionSeed,
  tasteVector,
  validateLog,
  viewSession,
} from "@abtune/engine";
import { fitTables, loadPersonas, PERSONAS_DIR, personaAnswerer, trackFit } from "@abtune/eval";
import { CliError, loadBank, openCatalog } from "../context.ts";

export const generateHelp = `abtune generate (--persona <id> | --answers <file.json>) [options]

Build a playlist (HANDOFF §9) from a quiz and print it.

  --persona <id>     let an eval persona (data/personas) answer the quiz
  --answers <file>   JSON {"answers": [{"id": "...", "choice": "a|b|both|skip"}], "mode"?, "packs"?}
  --mode <n>         questions to answer with --persona (default 20)
  --length <n>       playlist length (default 50)
  --salt <n>         reshuffle counter (default 0)
  --catalog <dir>    catalog directory (default: CATALOG_PATH or the best under data/catalog)
  --json             print JSON instead of a table`;

interface AnswersFile {
  readonly answers: readonly AnswerEvent[];
  readonly mode?: number;
  readonly packs?: readonly string[];
}

export async function generate(argv: readonly string[]): Promise<number> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      persona: { type: "string" },
      answers: { type: "string" },
      mode: { type: "string", default: "20" },
      length: { type: "string", default: "50" },
      salt: { type: "string", default: "0" },
      catalog: { type: "string" },
      json: { type: "boolean", default: false },
    },
  });
  if (!values.persona === !values.answers)
    throw new CliError("Pass exactly one of --persona or --answers.");
  const bank = await loadBank();
  const length = Number(values.length);
  const salt = Number(values.salt);

  let state: SessionState;
  let persona: Awaited<ReturnType<typeof loadPersonas>>[number] | undefined;
  if (values.persona) {
    const personas = await loadPersonas(path.resolve(PERSONAS_DIR), bank.dimensions);
    persona = personas.find((p) => p.id === values.persona);
    if (!persona)
      throw new CliError(
        `No persona "${values.persona}". Known: ${personas.map((p) => p.id).join(", ")}`,
      );
    state = runQuiz(
      bank,
      { mode: Number(values.mode), length, packs: defaultPacks(bank) },
      personaAnswerer(bank, persona),
    ).state;
  } else {
    const file = JSON.parse(await readFile(values.answers as string, "utf8")) as AnswersFile;
    validateLog(bank, file.answers);
    const answered = file.answers.filter((a) => a.choice !== "skip").length;
    const base = createSession(bank, {
      mode: file.mode ?? Math.max(1, answered),
      length,
      ...(file.packs ? { packs: file.packs } : {}),
    });
    state = { ...base, answer_log: file.answers };
  }
  state = { ...state, seed_salt: salt };

  const catalog = await openCatalog(bank, values.catalog);
  try {
    const view = viewSession(bank, state);
    const taste = tasteVector(bank, view.profile);
    const seed = sessionSeed(bank, state, catalog.columns.version);
    const t0 = performance.now();
    const out = generatePlaylist(catalog.columns, taste, { length, seed });
    const ms = performance.now() - t0;
    const title = playlistTitle(bank.dimensions, taste, view.answered, seed);
    const meta = await catalog.meta(out.tracks.map((t) => t.index));

    if (values.json) {
      console.log(
        JSON.stringify(
          {
            ...title,
            seed,
            catalog_version: catalog.columns.version,
            engine_version: engineVersion(bank),
            taste,
            warnings: out.warnings,
            tracks: meta.map((m, i) => ({ ...m, score: out.tracks[i]?.score })),
          },
          null,
          2,
        ),
      );
      return 0;
    }
    const tables = persona ? fitTables(catalog.columns, persona) : undefined;
    console.log(
      `${title.title}\n${title.description} · ${catalog.columns.version} (${catalog.manifest.kind})`,
    );
    console.log(
      `${view.answered} answers, ${out.tracks.length} tracks in ${ms.toFixed(0)} ms (catalog load ${(catalog.loadMs / 1000).toFixed(1)} s)`,
    );
    if (out.warnings.length > 0) console.log(`warnings: ${out.warnings.join(", ")}`);
    console.log(
      `cells: ${out.cells
        .slice(0, 8)
        .map((c) => `${c.genre ?? "–"}/${c.decade ?? "–"} ${c.picked}`)
        .join(", ")}${out.cells.length > 8 ? `, … (${out.cells.length})` : ""}\n`,
    );
    out.tracks.forEach((t, i) => {
      const m = meta[i];
      if (!m) return;
      const fit = tables ? ` fit ${trackFit(catalog.columns, tables, t.index).fit.toFixed(2)}` : "";
      console.log(
        `${String(i + 1).padStart(3)}. ${m.artist_credit} — ${m.title} (${m.year ?? "?"}) [${t.genre ?? "–"} ${t.decade ?? "–"}] score ${t.score.toFixed(3)}${fit}`,
      );
    });
    return 0;
  } finally {
    catalog.close();
  }
}
