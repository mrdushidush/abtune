import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { CatalogManifest } from "@abtune/catalog";
import { loadCatalog } from "@abtune/catalog/reader";
import {
  createSession,
  engineVersion,
  reduceSession,
  type SessionState,
  sessionSeed,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import { afterAll, describe, expect, it } from "vitest";
import type { PlaylistRequest, PlaylistResponse } from "../src/api-types.ts";
import { createApp, MAX_BODY_BYTES } from "../src/server/app.ts";
import { catalogInfo, catalogSlot } from "../src/server/catalog.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

describe("POST /api/playlist", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: repo("data/questions") });
  if (!bank) throw new Error("seed bank failed to load");
  const dir = repo("data/catalog-fixture");
  const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8")) as CatalogManifest;
  const loaded = await loadCatalog(dir, bank.dimensions, { threads: 2 });
  afterAll(() => loaded.close());
  const info = catalogInfo(manifest);
  const slot = catalogSlot(info, Promise.resolve(loaded));
  await slot.settled;
  const app = createApp({ bank, version: "9.9.9", catalog: slot });

  // A 10-answer session, always picking A.
  let state: SessionState = createSession(bank, { mode: 10, length: 25 });
  while (viewSession(bank, state).status === "asking")
    state = reduceSession(bank, state, { type: "answer", choice: "a" });
  const request: PlaylistRequest = {
    taste: tasteVector(bank, viewSession(bank, state).profile),
    seed: sessionSeed(bank, state, info.version),
    length: 25,
    engine_version: engineVersion(bank),
    catalog_version: info.version,
  };

  const post = (body: unknown, raw = false) =>
    app.request("/api/playlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: raw ? (body as string) : JSON.stringify(body),
    });

  it("returns N tracks with display data, deterministically", async () => {
    const res = await post(request);
    expect(res.status).toBe(200);
    const body = (await res.json()) as PlaylistResponse;
    expect(body).toMatchObject({
      catalog_version: "catalog-2026.09.2",
      catalog_kind: "fixture",
      engine_version: engineVersion(bank),
      seed: request.seed,
      length: 25,
    });
    expect(body.tracks).toHaveLength(25);
    expect(new Set(body.tracks.map((t) => t.track_id)).size).toBe(25);
    for (const t of body.tracks) {
      expect(t.track_id).toMatch(/^[0-9a-f-]{36}$/);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.artist.length).toBeGreaterThan(0);
    }
    const again = (await (await post(request)).json()) as PlaylistResponse;
    expect(again).toEqual(body);
  });

  it("changes with the seed", async () => {
    const a = (await (await post(request)).json()) as PlaylistResponse;
    const salted = { ...state, seed_salt: 1 };
    const b = (await (
      await post({ ...request, seed: sessionSeed(bank, salted, info.version) })
    ).json()) as PlaylistResponse;
    expect(b.tracks.map((t) => t.track_id)).not.toEqual(a.tracks.map((t) => t.track_id));
  });

  it("rejects malformed requests", async () => {
    const bad: unknown[] = [
      [],
      { ...request, seed: "XYZ" },
      { ...request, length: 0 },
      { ...request, length: 101 },
      { ...request, length: 2.5 },
      { ...request, engine_version: undefined },
      { ...request, taste: { ...request.taste, target: [1, 2] } },
      { ...request, taste: { ...request.taste, weight: "x" } },
      { ...request, taste: { ...request.taste, genres: [0, 0] } },
      {
        ...request,
        taste: { ...request.taste, decades: request.taste.decades?.map(() => 0) ?? [0] },
      },
    ];
    for (const body of bad) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body).slice(0, 80)).toBe(400);
      expect(((await res.json()) as { error: string }).error).toBe("bad_request");
    }
    expect((await post("{nope", true)).status).toBe(400);
  });

  it("rejects oversized bodies", async () => {
    const res = await post({ ...request, pad: "x".repeat(MAX_BODY_BYTES) });
    expect(res.status).toBe(413);
  });

  it("asks the client to resync on a version mismatch", async () => {
    for (const body of [
      { ...request, engine_version: "0.0.1+bank.00000000" },
      { ...request, catalog_version: "catalog-1999.01" },
    ]) {
      const res = await post(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: "version_mismatch",
        engine_version: engineVersion(bank),
        catalog_version: "catalog-2026.09.2",
      });
    }
  });

  it("is unavailable without a ready catalog", async () => {
    const none = createApp({ bank, version: "9.9.9" });
    expect(
      (
        await none.request("/api/playlist", {
          method: "POST",
          body: JSON.stringify(request),
          headers: { "content-type": "application/json" },
        })
      ).status,
    ).toBe(503);
    const loading = createApp({
      bank,
      version: "9.9.9",
      catalog: catalogSlot(info, new Promise(() => {})),
    });
    const res = await loading.request("/api/playlist", {
      method: "POST",
      body: JSON.stringify(request),
      headers: { "content-type": "application/json" },
    });
    expect(res.status).toBe(503);
    expect(res.headers.get("retry-after")).toBe("2");
    expect(await res.json()).toMatchObject({ error: "catalog_loading" });
  });
});
