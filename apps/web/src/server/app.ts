import type { Bank } from "@abtune/engine";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";

export interface AppOptions {
  readonly bank: Bank;
  readonly version: string;
  /** Built SPA directory (relative to cwd or absolute). Omit to serve the API only. */
  readonly staticRoot?: string;
  /** The installed music catalog, if any (`abtune catalog fetch` or a full build). */
  readonly catalog?: CatalogInfo | null;
}

export interface CatalogInfo {
  readonly version: string;
  readonly kind: string;
  readonly tracks: number;
}

export function packCounts(bank: Bank): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of Object.keys(bank.packs)) counts[name] = 0;
  for (const q of bank.questions) counts[q.pack] = (counts[q.pack] ?? 0) + 1;
  return counts;
}

export function createApp({ bank, version, staticRoot, catalog = null }: AppOptions): Hono {
  const app = new Hono();

  app.get("/api/health", (c) =>
    c.json({
      name: "ABTune",
      version,
      questions: bank.questions.length,
      packs: packCounts(bank),
      catalog,
    }),
  );

  app.all("/api/*", (c) => c.json({ error: "not_found" }, 404));

  if (staticRoot !== undefined) {
    app.use("/*", serveStatic({ root: staticRoot }));
    // SPA fallback: client-side routes get index.html.
    app.get("*", serveStatic({ root: staticRoot, path: "index.html" }));
  }

  return app;
}
