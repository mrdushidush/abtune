import { existsSync } from "node:fs";
import path from "node:path";
import { aiSettings, createAiRuntime } from "@abtune/ai";
import { formatDiagnostic } from "@abtune/bank";
import { loadBankFromDisk } from "@abtune/bank/node";
import { findCatalog } from "@abtune/catalog";
import { loadCatalog } from "@abtune/catalog/reader";
import { missingSettings, spotifySettings } from "@abtune/connectors/spotify";
import { naturalShares, warmFamiliarity } from "@abtune/engine";
import { serve } from "@hono/node-server";
import pkg from "../../package.json" with { type: "json" };
import { createApp } from "./app.ts";
import { type CatalogSlot, catalogInfo, catalogSlot } from "./catalog.ts";

const repoRoot = path.resolve(import.meta.dirname, "../../../..");
// `.env` at the repo root when run with Node directly (Docker passes it as the environment).
// Variables already set win.
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
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
const bank = result.bank;

const installed = await findCatalog(
  path.join(repoRoot, "data/catalog"),
  process.env.CATALOG_PATH || undefined,
);

// Listen first; the catalog's columns load in the background (~8 s for the full catalog).
let catalog: CatalogSlot | null = null;
if (installed) {
  const info = catalogInfo(installed.manifest);
  // Per-catalog generator caches are built before the slot reports ready, so no request pays.
  const loading = loadCatalog(installed.dir, bank.dimensions).then((loaded) => {
    warmFamiliarity(loaded.columns);
    naturalShares(loaded.columns);
    return loaded;
  });
  catalog = catalogSlot(info, loading);
  catalog.settled.then(() => {
    const state = catalog?.state;
    if (state?.status === "ready") {
      console.log(
        `Catalog ${info.version} (${info.kind}, ${info.tracks} tracks) ready in ${(state.catalog.loadMs / 1000).toFixed(1)} s`,
      );
    } else if (state?.status === "error") {
      console.error(`Catalog ${installed.dir} failed to load: ${state.message}`);
    }
  });
}

const spotify = spotifySettings(process.env, repoRoot);
const { settings: aiConfig, problems: aiProblems } = aiSettings(process.env);
for (const p of aiProblems) console.error(`AI: ${p.setting} ${p.message}; the AI layer is off.`);
const ai = { settings: aiConfig, runtime: createAiRuntime(aiConfig) };
const app = createApp({
  bank,
  catalog,
  spotify,
  ai,
  version: pkg.version,
  staticRoot: path.relative(process.cwd(), staticDir) || ".",
});
const spotifyMissing = missingSettings(spotify);

serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(
    `ABTune ${pkg.version} on http://${info.address}:${info.port} (${bank.questions.length} questions, ` +
      `catalog: ${catalog ? `${catalog.info.version} ${catalog.info.kind}, ${catalog.info.tracks} tracks, loading` : "none; run `abtune catalog fetch`"}; ` +
      `Spotify: ${spotifyMissing.length ? `not set up (${spotifyMissing.join(", ")})` : `redirect ${spotify.redirectUri}`}; ` +
      `AI: ${ai.runtime ? `${aiConfig.model} at ${aiConfig.baseUrl}${aiConfig.rerank ? ", rerank on" : ""}` : "off"})`,
  );
});
