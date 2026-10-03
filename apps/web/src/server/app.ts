import { type Bank, engineVersion } from "@abtune/engine";
import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiError, Health } from "../api-types.ts";
import { type CatalogSlot, catalogHealth } from "./catalog.ts";
import { buildPlaylist, parsePlaylistRequest, UnknownTrackError } from "./playlist.ts";

export interface AppOptions {
  readonly bank: Bank;
  readonly version: string;
  /** Built SPA directory (relative to cwd or absolute). Omit to serve the API only. */
  readonly staticRoot?: string;
  /** The installed music catalog, if any (`abtune catalog fetch` or a full build). */
  readonly catalog?: CatalogSlot | null;
}

/** A playlist request is a taste vector and a few strings: well under this. */
export const MAX_BODY_BYTES = 16 * 1024;

export function packCounts(bank: Bank): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const name of Object.keys(bank.packs)) counts[name] = 0;
  for (const q of bank.questions) counts[q.pack] = (counts[q.pack] ?? 0) + 1;
  return counts;
}

const fail = (c: Context, status: 400 | 404 | 409 | 413 | 503, body: ApiError) =>
  c.json(body, status);

export function createApp({ bank, version, staticRoot, catalog = null }: AppOptions): Hono {
  const app = new Hono();
  const engine = engineVersion(bank);

  app.get("/api/health", (c) =>
    c.json({
      name: "ABTune",
      version,
      engine_version: engine,
      questions: bank.questions.length,
      packs: packCounts(bank),
      catalog: catalogHealth(catalog),
    } satisfies Health),
  );

  // The body is never logged: it is a profile, and the server keeps no record of it (HANDOFF §13).
  app.post(
    "/api/playlist",
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) => fail(c, 413, { error: "too_large", message: "Request body too large." }),
    }),
    async (c) => {
      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return fail(c, 400, { error: "bad_request", message: "Body must be JSON." });
      }
      const parsed = parsePlaylistRequest(body, bank.dimensions);
      if (!parsed.ok) return fail(c, 400, { error: "bad_request", message: parsed.message });
      if (!catalog) {
        return fail(c, 503, {
          error: "no_catalog",
          message: "No music catalog is installed. Run `abtune catalog fetch`.",
        });
      }
      const state = catalog.state;
      if (state.status === "loading") {
        c.header("Retry-After", "2");
        return fail(c, 503, { error: "catalog_loading", message: "The catalog is still loading." });
      }
      if (state.status === "error") {
        return fail(c, 503, { error: "catalog_error", message: "The catalog failed to load." });
      }
      const req = parsed.value;
      if (req.engine_version !== engine || req.catalog_version !== catalog.info.version) {
        return fail(c, 409, {
          error: "version_mismatch",
          engine_version: engine,
          catalog_version: catalog.info.version,
        });
      }
      try {
        return c.json(await buildPlaylist(state.catalog, req, engine));
      } catch (err) {
        if (err instanceof UnknownTrackError)
          return fail(c, 400, { error: "bad_request", message: "previous has unknown track ids." });
        throw err;
      }
    },
  );

  app.all("/api/*", (c) => fail(c, 404, { error: "not_found" }));

  if (staticRoot !== undefined) {
    app.use("/*", serveStatic({ root: staticRoot }));
    // SPA fallback: client-side routes get index.html.
    app.get("*", serveStatic({ root: staticRoot, path: "index.html" }));
  }

  return app;
}
