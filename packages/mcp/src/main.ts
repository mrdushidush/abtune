#!/usr/bin/env node
// ABTune MCP server over stdio (HANDOFF §12). Add it to Claude Code with
//   claude mcp add abtune -- node /path/to/abtune/packages/mcp/src/main.ts
// Environment: QUESTIONS_DIR, CATALOG_PATH (default: the best catalog under data/catalog),
// APP_BASE_URL (where share links point; default http://127.0.0.1:8787), and the Spotify settings
// (push_to_spotify uses the connection made in the web app). The repo's `.env` is read too.
import { existsSync } from "node:fs";
import path from "node:path";
import { formatDiagnostic } from "@abtune/bank";
import { loadBankFromDisk } from "@abtune/bank/node";
import { spotifySettings } from "@abtune/connectors/spotify";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import pkg from "../package.json" with { type: "json" };
import { CatalogHandle } from "./playlist.ts";
import { createServer } from "./server.ts";

// stdout carries the protocol: anything a library logs goes to stderr instead.
console.log = console.error;
console.info = console.error;

const repoRoot = path.resolve(import.meta.dirname, "../../..");
// The web app's `.env` (Spotify settings, APP_BASE_URL); variables already set win.
const envFile = path.join(repoRoot, ".env");
if (existsSync(envFile)) process.loadEnvFile(envFile);
const questionsDir = process.env.QUESTIONS_DIR ?? path.join(repoRoot, "data/questions");
const result = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
if (!result.bank || result.errors > 0) {
  for (const d of result.diagnostics) console.error(formatDiagnostic(d));
  console.error(`Question bank in ${questionsDir} has errors; refusing to start.`);
  process.exit(1);
}
const bank = result.bank;
const catalog = new CatalogHandle(
  path.join(repoRoot, "data/catalog"),
  process.env.CATALOG_PATH || undefined,
  bank.dimensions,
);
const server = createServer({
  bank,
  catalog,
  version: pkg.version,
  spotify: spotifySettings(process.env, repoRoot),
  ...(process.env.APP_BASE_URL ? { appBaseUrl: process.env.APP_BASE_URL } : {}),
});
await server.connect(new StdioServerTransport());
// Start loading the catalog now (the full one takes ~8 s), so it's usually ready by the time a
// host has read the questions and answered them. A failure is reported by generate_playlist.
catalog.get().catch(() => {});
const stop = () => {
  catalog.close();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
