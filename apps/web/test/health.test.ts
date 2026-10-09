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
      questions: 357,
      packs: { core: 105, context: 17, deep: 133, vibe: 73, spicy: 9, il: 20 },
      catalog: null,
      ai: { enabled: false, rerank: false, sensitive_opt_in: false, model: null },
      spotify: { configured: false },
      share_url: "https://abtune.com/",
      stats: false,
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

  it("sends security headers with a strict CSP", async () => {
    const res = await app.request("/api/health");
    const csp = res.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    // no-referrer would make browsers send `Origin: null` on the app's own POSTs.
    expect(res.headers.get("referrer-policy")).toBe("same-origin");
    expect(res.headers.get("strict-transport-security")).toBeNull();
  });

  it("answers only to loopback, IP addresses and configured hosts (DNS rebinding)", async () => {
    const proxied = createApp({ bank, version: "9.9.9", hosts: ["abtune.example.com"] });
    for (const host of [
      "http://127.0.0.1:8787",
      "http://localhost:5173",
      "http://[::1]:8787",
      "http://192.168.1.5:8787",
      "http://abtune.localhost",
      "https://ABTune.example.com",
    ])
      expect((await proxied.request(`${host}/api/health`)).status, host).toBe(200);
    for (const host of ["http://rebind.attacker.example:8787", "http://example.com"]) {
      const res = await proxied.request(`${host}/api/health`);
      expect(res.status, host).toBe(403);
      expect(((await res.json()) as { error: string }).error).toBe("unknown_host");
    }
  });
});
