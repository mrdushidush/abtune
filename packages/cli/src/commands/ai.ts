import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";
import {
  type AiAdjustment,
  AiCache,
  type AiRuntime,
  type AiSettings,
  aiSettings,
  answerLines,
  ENRICH_BATCH,
  ENRICH_DIMS,
  type EnrichDim,
  enrichTask,
  fitLine,
  interpretTask,
  loadPrompt,
  openaiCompat,
  runTask,
  spearman,
  tweakTask,
} from "@abtune/ai";
import type { LoadedCatalog } from "@abtune/catalog/reader";
import {
  ADJUST_KINDS,
  answersForAi,
  applyAdjust,
  type Bank,
  clusterLabel,
  createSession,
  engineVersion,
  reduceSession,
  type SessionState,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import {
  DEFAULT_EVAL,
  type EvalSettings,
  evaluateQuizzes,
  loadPersonas,
  PERSONAS_DIR,
  type PersonaQuiz,
  readCanon,
  recognition,
  runPersonaQuizzes,
  summarize,
} from "@abtune/eval";
import { CliError, loadBank, openCatalog } from "../context.ts";

export const aiHelp = `abtune ai <check | eval | enrich> [options]

Measure the optional AI layer (HANDOFF §10) with the model configured in .env.

The model is AI_PROVIDER=openai_compat at AI_BASE_URL (LM Studio, Ollama, llama.cpp, vLLM).

  check                  list the server's models, then time one interpret and one tweak call
  eval                   T1 on the persona eval: playlists with and without the AI's adjustment
    --modes <list>       quiz depths (default 10,20,50)
    --salts <n>          playlists per persona and mode (default 3)
    --personas <ids>     comma-separated persona ids (default: all)
    --out <file>         report (default for a full catalog: docs/eval/<date>-ai-interpret.md)
  enrich                 T4: the model rates catalog songs on the AcousticBrainz dims
    --eval <n>           rate n songs that have AcousticBrainz data (in the popularity band of
                         the songs T4 would rate) and report the error after calibration
    --band <n>           that band: the n most popular songs with model features (default 20000)
    --out <file>         report (default for a full catalog: docs/eval/<date>-ai-enrich.md)

Common options:
  --catalog <dir>        catalog directory (default: CATALOG_PATH or the best under data/catalog)
  --timeout <ms>         per call (default AI_TIMEOUT_MS or 20000)
  --max-gpu-temp <°C>    pause between calls while an NVIDIA GPU is at least this hot (default 65;
                         0 = off). Needs nvidia-smi.`;

const log = (line: string) => console.log(`[${new Date().toISOString().slice(11, 19)}] ${line}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** The hottest NVIDIA GPU in °C, or null without nvidia-smi. */
function gpuTemp(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "nvidia-smi",
      ["--query-gpu=temperature.gpu", "--format=csv,noheader,nounits"],
      { timeout: 5000 },
      (err, out) => {
        if (err) return resolve(null);
        const temps = out
          .split(/\r?\n/)
          .map(Number)
          .filter((x) => Number.isFinite(x) && x > 0);
        resolve(temps.length ? Math.max(...temps) : null);
      },
    );
  });
}

/** Wait until the GPU is cooler than `limit` (the owner's thermal rule). No-op when off. */
async function coolDown(limit: number): Promise<void> {
  if (limit <= 0) return;
  let t = await gpuTemp();
  if (t === null || t < limit) return;
  log(`GPU at ${t}°C (limit ${limit}°C): pausing`);
  while (t !== null && t >= limit - 3) {
    await sleep(10_000);
    t = await gpuTemp();
  }
  log(`GPU at ${t}°C: going on`);
}

function settingsFrom(timeout: string | undefined): AiSettings {
  // `.env` at the working directory, like the server; variables already set win.
  if (existsSync(".env")) process.loadEnvFile(".env");
  const { settings, problems } = aiSettings(process.env);
  for (const p of problems) log(`AI: ${p.setting} ${p.message}`);
  if (settings.provider === "none")
    throw new CliError(
      "No model configured. Set AI_PROVIDER=openai_compat, AI_BASE_URL and AI_MODEL in .env.",
    );
  const ms = timeout ? Number(timeout) : settings.timeoutMs;
  if (!Number.isInteger(ms) || ms < 1000) throw new CliError("--timeout must be ≥ 1000 ms.");
  return { ...settings, timeoutMs: ms };
}

/** A cache kept in a JSON file between runs: for T4 only (catalog text, no user data). */
class FileCache extends AiCache {
  private readonly file: string;
  constructor(file: string) {
    super(1_000_000);
    this.file = file;
  }
  async load(): Promise<this> {
    try {
      const data = JSON.parse(await readFile(this.file, "utf8")) as Record<string, unknown>;
      for (const [k, v] of Object.entries(data)) this.set(k, v);
    } catch {}
    return this;
  }
  async save(): Promise<void> {
    await mkdir(path.dirname(this.file), { recursive: true });
    await writeFile(this.file, `${JSON.stringify(Object.fromEntries(this.entries()))}\n`);
  }
}

const fmt = (x: number, d = 3) => x.toFixed(d);
const pct = (x: number) => `${(100 * x).toFixed(1)}%`;
const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] as number) : 0;
};

export async function ai(argv: readonly string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const { values } = parseArgs({
    args: [...rest],
    options: {
      catalog: { type: "string" },
      timeout: { type: "string" },
      "max-gpu-temp": { type: "string", default: "65" },
      modes: { type: "string", default: "10,20,50" },
      salts: { type: "string", default: "3" },
      personas: { type: "string" },
      eval: { type: "string" },
      band: { type: "string", default: "20000" },
      out: { type: "string" },
    },
  });
  const limit = Number(values["max-gpu-temp"]);
  if (sub === "check") return check(settingsFrom(values.timeout));
  if (sub === "eval")
    return interpretEval(settingsFrom(values.timeout), {
      catalog: values.catalog,
      modes: values.modes.split(",").map(Number),
      salts: Number(values.salts),
      personas: values.personas?.split(",") ?? null,
      out: values.out,
      limit,
    });
  if (sub === "enrich") {
    if (!values.eval)
      throw new CliError("enrich needs --eval <n> (writing estimates comes later).");
    return enrichEval(settingsFrom(values.timeout), {
      catalog: values.catalog,
      n: Number(values.eval),
      band: Number(values.band),
      out: values.out,
      limit,
    });
  }
  throw new CliError(`Unknown subcommand "${sub ?? ""}". Use check, eval or enrich.`);
}

/** A finished 10-answer session, always A: a fixed input for `check`. */
function sampleSession(bank: Bank): SessionState {
  let s = createSession(bank, { mode: 10, length: 25 });
  while (viewSession(bank, s).status === "asking")
    s = reduceSession(bank, s, { type: "answer", choice: "a" });
  return s;
}

async function check(settings: AiSettings): Promise<number> {
  log(`model ${settings.model} at ${settings.baseUrl} (timeout ${settings.timeoutMs} ms)`);
  try {
    const res = await fetch(`${settings.baseUrl}/models`, {
      headers: settings.apiKey ? { authorization: `Bearer ${settings.apiKey}` } : {},
      signal: AbortSignal.timeout(5000),
    });
    const body = (await res.json()) as { data?: { id: string }[] };
    const ids = (body.data ?? []).map((m) => m.id);
    log(`server lists ${ids.length} model(s)${ids.length ? `: ${ids.join(", ")}` : ""}`);
    if (ids.length && !ids.includes(settings.model))
      log(`warning: AI_MODEL "${settings.model}" isn't in that list`);
  } catch (err) {
    log(`can't list models: ${(err as Error).message}`);
    return 1;
  }
  const bank = await loadBank();
  const session = sampleSession(bank);
  const taste = tasteVector(bank, viewSession(bank, session).profile);
  const rt: AiRuntime = {
    provider: openaiCompat(settings),
    timeoutMs: settings.timeoutMs,
    cache: new AiCache(),
    log,
  };
  let ok = true;
  const t0 = performance.now();
  const r1 = await runTask(rt, interpretTask(), {
    dims: bank.dimensions,
    taste,
    answers: answerLines(bank, answersForAi(bank, session.answer_log, false)),
  });
  log(`interpret: ${((performance.now() - t0) / 1000).toFixed(1)} s, ${r1.ok ? "ok" : r1.failure}`);
  if (r1.ok) describeAdjustment(r1.value);
  else ok = false;
  const t1 = performance.now();
  const r2 = await runTask(rt, tweakTask(), {
    dims: bank.dimensions,
    taste,
    request: "a rainy Sunday morning",
  });
  log(`tweak: ${((performance.now() - t1) / 1000).toFixed(1)} s, ${r2.ok ? "ok" : r2.failure}`);
  if (r2.ok) describeAdjustment(r2.value);
  else ok = false;
  return ok ? 0 : 1;
}

function describeAdjustment(v: AiAdjustment): void {
  log(`  title: ${v.title ?? "(none)"}`);
  log(`  blurb: ${v.blurb ?? "(none)"}`);
  for (const kind of ADJUST_KINDS) {
    const entries = Object.entries(v.adjust[kind]);
    if (entries.length)
      log(
        `  ${kind}: ${entries.map(([k, x]) => `${k} ${x > 0 ? "+" : ""}${(x / 100).toFixed(2)}`).join(", ")}`,
      );
  }
}

async function interpretEval(
  settings: AiSettings,
  opts: {
    catalog: string | undefined;
    modes: number[];
    salts: number;
    personas: string[] | null;
    out: string | undefined;
    limit: number;
  },
): Promise<number> {
  const bank = await loadBank();
  const all = await loadPersonas(path.resolve(PERSONAS_DIR), bank.dimensions);
  const personas = opts.personas ? all.filter((p) => opts.personas?.includes(p.id)) : all;
  if (personas.length === 0) throw new CliError("No such personas.");
  const catalog = await openCatalog(bank, opts.catalog);
  const columns = catalog.columns;
  try {
    const canon = await readCanon();
    const recog = recognition(
      columns,
      (await catalog.match(canon)).flat(),
      await catalog.numbers("proxy_listeners"),
    );
    const settingsEval: EvalSettings = { ...DEFAULT_EVAL, modes: opts.modes, salts: opts.salts };
    const quizzes = runPersonaQuizzes(bank, personas, settingsEval);
    const rt: AiRuntime = {
      provider: openaiCompat(settings),
      timeoutMs: settings.timeoutMs,
      cache: new AiCache(10_000),
      log,
    };
    log(`${quizzes.length} interpret calls to ${settings.model}…`);
    const made = new Map<PersonaQuiz, AiAdjustment>();
    const failures: Record<string, number> = {};
    const seconds: number[] = [];
    for (const q of quizzes) {
      await coolDown(opts.limit);
      const t0 = performance.now();
      const r = await runTask(rt, interpretTask(), {
        dims: bank.dimensions,
        taste: tasteVector(bank, q.view.profile, settingsEval.taste),
        answers: answerLines(bank, answersForAi(bank, q.state.answer_log, false)),
      });
      seconds.push((performance.now() - t0) / 1000);
      if (r.ok) made.set(q, r.value);
      else failures[r.failure] = (failures[r.failure] ?? 0) + 1;
      log(
        `${q.persona.id} @${q.mode}: ${seconds.at(-1)?.toFixed(1)} s ${r.ok ? `"${r.value.title ?? ""}"` : r.failure}`,
      );
    }
    const classic = summarize(evaluateQuizzes(bank, columns, quizzes, settingsEval, recog));
    const aiRows = evaluateQuizzes(bank, columns, quizzes, settingsEval, recog, (q, taste) => {
      const m = made.get(q);
      return m ? applyAdjust(bank.dimensions, taste, m.adjust) : taste;
    });
    const withAi = summarize(aiRows);
    const classicRows = evaluateQuizzes(bank, columns, quizzes, settingsEval, recog);
    const lines: string[] = [];
    lines.push(`# AI interpret eval (T1), ${new Date().toLocaleDateString("en-CA")}`);
    lines.push("");
    lines.push(
      `Model \`${settings.model}\`, prompt interpret v${loadPrompt("interpret").version}, catalog ${columns.version} (${catalog.manifest.kind}), engine ${engineVersion(bank)}.`,
    );
    lines.push(
      `${quizzes.length} calls: ${made.size} ok${Object.keys(failures).length ? `, failures ${JSON.stringify(failures)}` : ""}; median ${fmt(median(seconds), 1)} s, max ${fmt(Math.max(...seconds), 1)} s. ${personas.length} personas, modes ${opts.modes.join("/")}, ${opts.salts} playlists each, length ${settingsEval.length}.`,
    );
    lines.push("");
    lines.push(
      "| mode | fit classic | fit AI | canon classic | canon AI | sig classic | sig AI | Hebrew personas classic | AI |",
    );
    lines.push("|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
    classic.byMode.forEach((c, i) => {
      const a = withAi.byMode[i];
      if (!a) return;
      lines.push(
        `| ${c.mode} | ${fmt(c.metrics.fit)} | ${fmt(a.metrics.fit)} | ${fmt(c.metrics.canon, 2)} | ${fmt(a.metrics.canon, 2)} | ${pct(c.metrics.sig)} | ${pct(a.metrics.sig)} | ${pct(c.metrics.hebrew)} | ${pct(a.metrics.hebrew)} |`,
      );
    });
    lines.push("");
    lines.push(
      `Overall: canon ${fmt(classic.canon, 2)} → ${fmt(withAi.canon, 2)}, sig ${pct(classic.sig)} → ${pct(withAi.sig)}, Hebrew personas ${pct(classic.hebrewShare)} → ${pct(withAi.hebrewShare)}.`,
    );
    lines.push("");
    lines.push("Per persona (fit, classic → AI) and the AI's title:");
    lines.push("");
    lines.push(
      `| persona | ${opts.modes.map((m) => `@${m}`).join(" | ")} | title @${opts.modes.at(-1)} |`,
    );
    lines.push(`|---|${opts.modes.map(() => "---:").join("|")}|---|`);
    for (const p of personas) {
      const cells = opts.modes.map((m) => {
        const c = classicRows.find((r) => r.persona.id === p.id && r.mode === m);
        const a = aiRows.find((r) => r.persona.id === p.id && r.mode === m);
        return c && a ? `${fmt(c.metrics.fit)} → ${fmt(a.metrics.fit)}` : "";
      });
      const q = quizzes.find((x) => x.persona.id === p.id && x.mode === opts.modes.at(-1));
      const title = q ? (made.get(q)?.title ?? "") : "";
      lines.push(`| ${p.id} | ${cells.join(" | ")} | ${title} |`);
    }
    lines.push("");
    const report = `${lines.join("\n")}\n`;
    for (const l of lines.slice(4, 6 + opts.modes.length)) console.log(l);
    const full = catalog.manifest.kind === "full";
    const out =
      opts.out ??
      (full
        ? path.join("docs/eval", `${new Date().toLocaleDateString("en-CA")}-ai-interpret.md`)
        : undefined);
    if (out) {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, report);
      log(`wrote ${out}`);
    }
    return 0;
  } finally {
    catalog.close();
  }
}

/** build-stats.json's tier-3 holdout MAE per dim, when the catalog has it. */
async function tier3Mae(
  catalog: LoadedCatalog,
): Promise<Record<
  string,
  { maeRandom: number; baselineRandom: number; maeArtist: number; baselineArtist: number }
> | null> {
  try {
    const stats = JSON.parse(
      await readFile(path.join(catalog.dir, "build-stats.json"), "utf8"),
    ) as {
      steps: { step: string; info: { impute?: { dims: Record<string, never> } } }[];
    };
    return stats.steps.find((s) => s.step === "features")?.info.impute?.dims ?? null;
  } catch {
    return null;
  }
}

async function enrichEval(
  settings: AiSettings,
  opts: {
    catalog: string | undefined;
    n: number;
    band: number;
    out: string | undefined;
    limit: number;
  },
): Promise<number> {
  if (!Number.isInteger(opts.n) || opts.n < 20)
    throw new CliError("--eval needs at least 20 songs.");
  const bank = await loadBank();
  const catalog = await openCatalog(bank, opts.catalog);
  const columns = catalog.columns;
  try {
    const pop = await catalog.numbers("popularity_pct");
    const byPop = Array.from({ length: columns.n }, (_, i) => i).sort(
      (a, b) => (pop[b] as number) - (pop[a] as number) || a - b,
    );
    // The band: as popular as the songs T4 would rate (the most popular with model features).
    const band: number[] = [];
    const truth: number[] = [];
    for (
      let at = 0;
      at < byPop.length && (band.length < opts.band || truth.length < opts.n * 20);
      at += 2000
    ) {
      const chunk = byPop.slice(at, at + 2000);
      const meta = await catalog.meta(chunk);
      meta.forEach((m, k) => {
        const i = chunk[k] as number;
        if (m.feature_source === "model" && band.length < opts.band) band.push(i);
        else if (m.feature_source === "ab_direct" && m.year !== null) truth.push(i);
      });
      if (band.length >= opts.band && truth.length >= opts.n * 4) break;
    }
    const lo = pop[band.at(-1) ?? 0] as number;
    const inBand = truth.filter((i) => (pop[i] as number) >= lo);
    const pool = inBand.length >= opts.n ? inBand : truth;
    // Evenly spread over the pool, so the sample isn't only the very top.
    const sample = Array.from(
      { length: opts.n },
      (_, k) => pool[Math.floor((k * pool.length) / opts.n)] as number,
    );
    log(
      `${sample.length} songs with AcousticBrainz data, popularity ≥ ${fmt(lo)} (the top ${band.length} model-feature songs' band)`,
    );
    const raw: Record<string, Float64Array> = {};
    for (const d of ENRICH_DIMS) raw[d] = await catalog.numbers(`raw_${d}`);
    const meta = await catalog.meta(sample);
    const cache = await new FileCache(
      path.resolve("data/ai/cache", `enrich-${settings.model.replace(/[^\w.-]+/g, "_")}.json`),
    ).load();
    const rt: AiRuntime = {
      provider: openaiCompat(settings),
      timeoutMs: settings.timeoutMs,
      cache,
      log,
    };
    const ratings: (Readonly<Record<EnrichDim, number>> | null)[] = [];
    const seconds: number[] = [];
    let failed = 0;
    for (let b = 0; b < meta.length; b += ENRICH_BATCH) {
      await coolDown(opts.limit);
      const batch = meta.slice(b, b + ENRICH_BATCH);
      const t0 = performance.now();
      const r = await runTask(rt, enrichTask(), {
        songs: batch.map((m) => ({
          title: m.title,
          artist: m.artist_credit,
          year: m.year,
          genre: m.primary_cluster ? clusterLabel(m.primary_cluster) : null,
        })),
      });
      seconds.push((performance.now() - t0) / 1000);
      if (r.ok) ratings.push(...r.value);
      else {
        failed++;
        ratings.push(...batch.map(() => null));
      }
      log(
        `batch ${b / ENRICH_BATCH + 1}/${Math.ceil(meta.length / ENRICH_BATCH)}: ${seconds.at(-1)?.toFixed(1)} s ${r.ok ? (r.cached ? "cached" : "ok") : r.failure}`,
      );
      if (r.ok && !r.cached) await cache.save();
    }

    const known = ratings.map((r, k) => (r ? k : -1)).filter((k) => k >= 0);
    const t3 = await tier3Mae(catalog);
    const lines: string[] = [];
    lines.push(`# AI enrich eval (T4), ${new Date().toLocaleDateString("en-CA")}`);
    lines.push("");
    lines.push(
      `Model \`${settings.model}\`, prompt enrich v${loadPrompt("enrich").version}, catalog ${columns.version}. ${sample.length} songs with AcousticBrainz data in the popularity band of the ${band.length} most popular songs that use model features; the model knew ${known.length} (${pct(known.length / sample.length)}). ${failed} of ${seconds.length} batches failed; median ${fmt(median(seconds), 1)} s per ${ENRICH_BATCH} songs.`,
    );
    lines.push("");
    lines.push(
      "Ratings 1–5 are mapped to the raw [-1, 1] scale by a straight line fit on half the known songs and scored on the other half (2-fold). Baseline: predicting the fold's mean. Tier 3 is the ridge model's held-out MAE from the catalog build (another sample: the random holdout and unseen artists), shown as MAE/baseline ratios.",
    );
    lines.push("");
    lines.push(
      "| dim | LLM MAE | baseline | LLM ratio | Spearman | tier 3 ratio (random) | tier 3 ratio (unseen artists) |",
    );
    lines.push("|---|---:|---:|---:|---:|---:|---:|");
    for (const d of ENRICH_DIMS) {
      const xs = known.map((k) => (ratings[k] as Record<EnrichDim, number>)[d]);
      const ys = known.map((k) => (raw[d] as Float64Array)[sample[k] as number] as number);
      let err = 0;
      let base = 0;
      for (const fold of [0, 1]) {
        const train = xs.map((_, j) => j).filter((j) => j % 2 !== fold);
        const test = xs.map((_, j) => j).filter((j) => j % 2 === fold);
        const line = fitLine(
          train.map((j) => xs[j] as number),
          train.map((j) => ys[j] as number),
        );
        const mean = train.reduce((s, j) => s + (ys[j] as number), 0) / Math.max(1, train.length);
        for (const j of test) {
          const y = ys[j] as number;
          err += Math.abs((line ? line.a + line.b * (xs[j] as number) : mean) - y);
          base += Math.abs(mean - y);
        }
      }
      const n = Math.max(1, xs.length);
      const t = t3?.[d];
      lines.push(
        `| ${d} | ${fmt(err / n)} | ${fmt(base / n)} | ${fmt(err / Math.max(base, 1e-9), 2)} | ${fmt(spearman(xs, ys), 2)} | ${t ? fmt(t.maeRandom / t.baselineRandom, 2) : "?"} | ${t ? fmt(t.maeArtist / t.baselineArtist, 2) : "?"} |`,
      );
    }
    lines.push("");
    const report = `${lines.join("\n")}\n`;
    console.log(report);
    const full = catalog.manifest.kind === "full";
    const out =
      opts.out ??
      (full
        ? path.join("docs/eval", `${new Date().toLocaleDateString("en-CA")}-ai-enrich.md`)
        : undefined);
    if (out) {
      await mkdir(path.dirname(out), { recursive: true });
      await writeFile(out, report);
      log(`wrote ${out}`);
    }
    return 0;
  } finally {
    catalog.close();
  }
}
