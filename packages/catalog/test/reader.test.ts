import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { CLUSTER_SLOTS, LANG_INSTRUMENTAL, NONE } from "@abtune/engine";
import { afterAll, describe, expect, it } from "vitest";
import { readFixture } from "../src/fixture.ts";
import { loadCatalog } from "../src/reader.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

describe("loadCatalog on the committed fixture", async () => {
  const bank = await loadBankFromDisk(["*.yaml"], { cwd: path.join(REPO, "data/questions") });
  const dims = bank.bank?.dimensions;
  if (!dims) throw new Error("bank failed to load");
  const fixture = await readFixture();
  const cat = await loadCatalog(path.join(REPO, "data/catalog-fixture"), dims);
  afterAll(() => cat.close());
  const { columns } = cat;

  it("has every row, in track_id order", () => {
    expect(columns.n).toBe(5000);
    expect(columns.version).toBe("catalog-2026.09.2");
    fixture.tracks.forEach((t, i) => {
      expect(cat.trackId(i)).toBe(t.track_id);
    });
  });

  it("copies scalars, clusters, decade and language into the bank's index order", () => {
    fixture.tracks.forEach((t, i) => {
      dims.scalar.forEach((d, k) => {
        expect(columns.scalars[k]?.[i]).toBeCloseTo(
          (t as unknown as Record<string, number>)[d] ?? 0,
          4,
        );
      });
      expect(columns.confidence[i]).toBeCloseTo(t.feature_confidence, 4);
      const clusters = Object.entries(t.clusters).sort(
        ([a, wa], [b, wb]) => wb - wa || dims.genres.indexOf(a) - dims.genres.indexOf(b),
      );
      for (let k = 0; k < CLUSTER_SLOTS; k++) {
        const c = clusters[k];
        expect(columns.clusterIdx[i * CLUSTER_SLOTS + k]).toBe(
          c ? dims.genres.indexOf(c[0]) : NONE,
        );
        expect(columns.clusterW[i * CLUSTER_SLOTS + k]).toBeCloseTo(c ? c[1] : 0, 4);
      }
      expect(columns.primary[i]).toBe(
        t.primary_cluster ? dims.genres.indexOf(t.primary_cluster) : NONE,
      );
      expect(columns.decade[i]).toBe(t.decade ? dims.decades.indexOf(t.decade) : NONE);
      const lang = dims.languages.indexOf(t.language);
      expect(columns.lang[i]).toBe(
        lang >= 0 ? lang : t.language === "none" ? LANG_INSTRUMENTAL : NONE,
      );
      expect(columns.year[i]).toBe(t.year ?? 0);
    });
  });

  it("gives one id per first artist and per normalized title", () => {
    const byArtist = new Map<string, number>();
    fixture.tracks.forEach((t, i) => {
      const a = t.artist_mbids[0] as string;
      const id = columns.artist[i] as number;
      expect(byArtist.get(a) ?? id).toBe(id);
      byArtist.set(a, id);
    });
    expect(new Set(columns.artist).size).toBe(byArtist.size);
    // Different capitalization and punctuation, same song title.
    const keys = new Map<string, Set<number>>();
    fixture.tracks.forEach((t, i) => {
      const k = t.title
        .toLowerCase()
        .replace(/[^\p{L}\p{N}]+/gu, " ")
        .trim();
      if (!keys.has(k)) keys.set(k, new Set());
      keys.get(k)?.add(columns.titleKey[i] as number);
    });
    for (const ids of keys.values()) expect(ids.size).toBe(1);
  });

  it("looks up display rows by index, in the order asked", async () => {
    const rows = await cat.meta([42, 7, 4999]);
    expect(rows.map((r) => r.track_id)).toEqual(
      [42, 7, 4999].map((i) => fixture.tracks[i]?.track_id),
    );
    expect(rows[1]).toMatchObject({
      title: fixture.tracks[7]?.title,
      artist_credit: fixture.tracks[7]?.artist_credit,
      isrcs: fixture.tracks[7]?.isrcs,
    });
    rows.forEach((r, j) => {
      expect(r.length_ms).toBe(fixture.tracks[[42, 7, 4999][j] as number]?.length_ms);
    });
    expect(() => cat.trackId(5000)).toThrow();
  });

  it("rejects a catalog whose clusters the bank doesn't declare", async () => {
    const narrow = { ...dims, genres: dims.genres.filter((g) => g !== "metal") };
    await expect(loadCatalog(path.join(REPO, "data/catalog-fixture"), narrow)).rejects.toThrow(
      /metal/,
    );
  });
});
