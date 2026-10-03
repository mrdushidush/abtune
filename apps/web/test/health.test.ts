import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { engineVersion } from "@abtune/engine";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";
import { catalogSlot } from "../src/server/catalog.ts";

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
      engine_version: engineVersion(bank),
      questions: 336,
      packs: { core: 105, context: 17, deep: 112, vibe: 73, spicy: 9, il: 20 },
      catalog: null,
      ai: { enabled: false, rerank: false, sensitive_opt_in: false, model: null },
    });
  });

  it("reports the installed catalog and its load status", async () => {
    const info = { version: "catalog-2026.10", kind: "dev-sample", tracks: 50000, license: null };
    const loading = createApp({
      bank,
      version: "9.9.9",
      catalog: catalogSlot(info, new Promise(() => {})),
    });
    const body = (await (await loading.request("/api/health")).json()) as { catalog: unknown };
    expect(body.catalog).toEqual({ ...info, status: "loading" });

    const slot = catalogSlot(info, Promise.reject(new Error("boom")));
    await slot.settled;
    const failed = createApp({ bank, version: "9.9.9", catalog: slot });
    const after = (await (await failed.request("/api/health")).json()) as { catalog: unknown };
    expect(after.catalog).toEqual({ ...info, status: "error" });
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await app.request("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
  });
});
