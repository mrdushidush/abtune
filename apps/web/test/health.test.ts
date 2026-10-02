import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";

const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));

describe("API", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
  if (!bank) throw new Error("seed bank failed to load");
  const app = createApp({ bank, version: "9.9.9" });

  it("reports health with bank stats", async () => {
    const res = await app.request("/api/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "ABTune",
      version: "9.9.9",
      questions: 153,
      packs: { core: 40, context: 6, deep: 56, vibe: 42, spicy: 9 },
      catalog: null,
    });
  });

  it("reports the installed catalog", async () => {
    const withCatalog = createApp({
      bank,
      version: "9.9.9",
      catalog: { version: "catalog-2026.10", kind: "dev-sample", tracks: 50000 },
    });
    const body = (await (await withCatalog.request("/api/health")).json()) as { catalog: unknown };
    expect(body.catalog).toEqual({ version: "catalog-2026.10", kind: "dev-sample", tracks: 50000 });
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
