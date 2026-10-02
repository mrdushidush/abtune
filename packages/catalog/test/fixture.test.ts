import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { describe, expect, it } from "vitest";
import { readFixture } from "../src/fixture.ts";
import { SCALAR_COLUMNS } from "../src/schema.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

describe("committed 5k fixture (data/catalog-fixture)", async () => {
  const fixture = await readFixture(undefined, true); // validates every row against the zod schema
  const bank = await loadBankFromDisk(["*.yaml"], { cwd: path.join(REPO, "data/questions") });
  const dims = bank.bank?.dimensions;

  it("has 5,000 unique tracks in track_id order, matching the manifest digest", () => {
    expect(fixture.manifest).toMatchObject({
      name: "abtune-catalog",
      kind: "fixture",
      tracks: 5000,
    });
    expect(fixture.tracks).toHaveLength(5000);
    const ids = fixture.tracks.map((t) => t.track_id);
    expect(new Set(ids).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
    expect(createHash("sha256").update(fixture.text).digest("hex")).toBe(fixture.manifest.digest);
  });

  it("is licensed CC BY-NC-SA 3.0 US and traces back to a full catalog", () => {
    expect(fixture.manifest.license.id).toBe("CC-BY-NC-SA-3.0-US");
    expect(fixture.manifest.derived_from?.tracks).toBeGreaterThan(1_000_000);
  });

  it("covers Hebrew and English", () => {
    const hebrew = fixture.tracks.filter(
      (t) => t.language === "lang_he" || t.artist_country === "IL",
    );
    expect(hebrew.length).toBeGreaterThanOrEqual(100);
    expect(fixture.tracks.filter((t) => t.language === "lang_en").length).toBeGreaterThan(1000);
  });

  it("uses only the bank's dimension names", () => {
    if (!dims) throw new Error("bank failed to load");
    const genres = new Set(dims.genres);
    const decades = new Set(dims.decades);
    for (const t of fixture.tracks) {
      for (const c of Object.keys(t.clusters)) expect(genres.has(c)).toBe(true);
      if (t.primary_cluster !== null) expect(genres.has(t.primary_cluster)).toBe(true);
      if (t.decade !== null) expect(decades.has(t.decade)).toBe(true);
      expect([
        "lang_en",
        "lang_he",
        "lang_fr",
        "lang_es",
        "lang_other",
        "none",
        "unknown",
      ]).toContain(t.language);
    }
    expect(fixture.manifest.dimensions.genres).toEqual(dims.genres);
  });

  it("spans every scalar axis and every decade", () => {
    for (const d of SCALAR_COLUMNS) {
      const v = fixture.tracks.map((t) => t[d]);
      expect(Math.min(...v)).toBeLessThan(-0.8);
      expect(Math.max(...v)).toBeGreaterThan(0.8);
    }
    const decades = new Set(fixture.tracks.map((t) => t.decade));
    for (const d of dims?.decades ?? []) expect(decades.has(d)).toBe(true);
  });
});
