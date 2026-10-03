import { createHash } from "node:crypto";
import { access, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { Dimensions } from "@abtune/engine";
import { beforeAll, describe, expect, it } from "vitest";
import { type BuildResult, buildCatalog, buildSamples, DEFAULT_CONFIG } from "../src/build.ts";
import { Db, pathLit } from "../src/db.ts";
import { fetchSample } from "../src/fetch.ts";
import { readFixture } from "../src/fixture.ts";
import { buildLayout } from "../src/steps.ts";
import { uuid, writeSyntheticDumps } from "./synthetic.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

let dims: Dimensions;
let dumps: string;
let root: string;
let ilArtistsFile: string;

/** The curated Israeli list: Omer Adam with a pinned song (and one that doesn't exist), Arik Einstein. */
const IL_ARTISTS = `version: 1
artists:
  - { name: Omer Adam, mbid: ${uuid(4, 2)}, tier: 1, songs: [Shir, No Such Song] }
  - { name: Arik Einstein, mbid: ${uuid(4, 4)}, tier: 2 }
`;

/** Popularity API stand-in: deterministic counts from the MBID text. */
const fakeApi: typeof fetch = async (_url, init) => {
  const { recording_mbids } = JSON.parse(String(init?.body)) as { recording_mbids: string[] };
  const rows = recording_mbids.map((m) => {
    const n = [...m].reduce((a, c) => a + c.charCodeAt(0), 0);
    return { recording_mbid: m, total_user_count: 100 + (n % 900), total_listen_count: 1000 + n };
  });
  return new Response(JSON.stringify(rows), {
    status: 200,
    headers: { "x-ratelimit-remaining": "29" },
  });
};

async function build(name: string, api: boolean): Promise<BuildResult> {
  const lines: string[] = [];
  return buildCatalog({
    config: {
      ...DEFAULT_CONFIG,
      version: "catalog-test",
      target: 100,
      candidates: 1000,
      api,
      pools: [{ name: "he", countries: ["IL"], languages: ["heb"], script: "Hebrew", min: 3 }],
    },
    dims,
    layout: {
      ...buildLayout({
        version: "catalog-test",
        dumps,
        buildDir: path.join(root, `build-${name}`),
        outDir: path.join(root, `out-${name}`),
      }),
    },
    tagMapFile: path.join(REPO, "data/tag_map.yaml"),
    ilArtistsFile,
    apiCacheDir: path.join(root, `api-${name}`),
    fetchImpl: fakeApi,
    reportFile: path.join(root, `report-${name}.md`),
    threads: 2,
    memoryLimit: "1GB",
    log: (l) => lines.push(l),
  });
}

async function rows(result: BuildResult): Promise<Record<string, unknown>[]> {
  const db = await Db.open(":memory:");
  try {
    return await db.all(
      `SELECT * FROM read_parquet(${pathLit(path.join(result.outDir, "tracks.parquet"))}) ORDER BY track_id`,
    );
  } finally {
    db.close();
  }
}

describe("catalog pipeline on synthetic dumps", () => {
  let a: BuildResult;
  let tracks: Record<string, unknown>[];
  const byId = (id: string) => tracks.find((t) => t.track_id === id);

  beforeAll(async () => {
    const bank = await loadBankFromDisk(["*.yaml"], { cwd: path.join(REPO, "data/questions") });
    if (!bank.bank) throw new Error("bank failed to load");
    dims = bank.bank.dimensions;
    ({ dumps, root } = await writeSyntheticDumps());
    ilArtistsFile = path.join(root, "il_artists.yaml");
    await writeFile(ilArtistsFile, IL_ARTISTS);
    a = await build("a", false);
    tracks = await rows(a);
  }, 240_000);

  it("selects exactly the target size, with the Hebrew quota met", () => {
    expect(tracks).toHaveLength(100);
    expect(a.manifest.tracks).toBe(100);
    const hebrew = tracks.filter((t) => t.language === "lang_he" || t.artist_country === "IL");
    expect(hebrew.length).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the title's script when no work or release language is recorded", () => {
    expect(byId(uuid(1, 14))).toMatchObject({
      title: "שיר ערש",
      language: "lang_he",
      language_iso: "heb",
      artist_country: null,
    });
  });

  it("collapses remasters and redirects into one song, earliest year, all ISRCs", () => {
    const prayer = tracks.filter((t) => String(t.title).startsWith("Livin' on a Prayer"));
    const studio = byId(uuid(1, 1));
    expect(studio).toMatchObject({
      year: 1986,
      decade: "dec80",
      version_type: "studio",
      language: "lang_en",
      feature_source: "ab_direct",
    });
    expect(studio?.isrcs).toEqual(["USPR31100001", "USPR38600001"]);
    // The remaster (recording 2, partly listened via a merged MBID) is folded in, not listed.
    expect(byId(uuid(1, 2))).toBeUndefined();
    // The live version is popular in its own right, so it stays as a separate track (§6.6).
    expect(byId(uuid(1, 3))).toMatchObject({ version_type: "live" });
    expect(prayer).toHaveLength(2);
  });

  it("uses canonical redirects for features (tier 1) and work siblings (tier 2)", () => {
    expect(byId(uuid(1, 4))).toMatchObject({ title: "Bed of Roses", feature_source: "ab_direct" });
    expect(byId(uuid(1, 6))).toMatchObject({
      title: "Shir",
      feature_source: "ab_sibling",
      language: "lang_he",
      artist_country: "IL",
    });
  });

  it("takes language from works, then the release, and resolves city areas to countries", () => {
    expect(byId(uuid(1, 8))).toMatchObject({
      title: "Ani Ve'Ata",
      language: "lang_he",
      artist_country: "IL",
      decade: "dec70",
    });
  });

  it("imputes features for tracks without AcousticBrainz data (tier 3)", () => {
    expect(byId(uuid(1, 9))).toMatchObject({
      title: "Fresh 2024",
      feature_source: "model",
      decade: "dec20",
    });
  });

  it("drops non-music and placeholder entries", () => {
    const titles = new Set(tracks.map((t) => t.title));
    for (const t of ["Medley", "Airport Bit", "Karaoke Version of Always", "Intro"])
      expect(titles.has(t)).toBe(false);
  });

  it("represents a song by a full-length recording, not a snippet that soaked up the listens", () => {
    expect(byId(uuid(1, 16))).toBeUndefined();
    expect(byId(uuid(1, 17))).toMatchObject({ title: "Umbrella", length_ms: 240_000 });
  });

  it("ranks an artist's songs by proxy listeners and Various-Artists compilations", () => {
    expect(byId(uuid(1, 19))).toMatchObject({
      title: "The Hit",
      release_groups: 2,
      comps: 2,
      va_comps: 2,
      artist_rank: 1,
      market: "intl",
    });
    expect(byId(uuid(1, 18))).toMatchObject({ title: "Album Cut", va_comps: 0, artist_rank: 2 });
    expect(byId(uuid(1, 20))).toMatchObject({ title: "B-Side", artist_rank: 3 });
    expect(Number(byId(uuid(1, 18))?.proxy_listeners)).toBeGreaterThan(
      Number(byId(uuid(1, 19))?.proxy_listeners),
    );
  });

  it("puts curated Israeli artists' top songs in the hits view, pins first", () => {
    expect(byId(uuid(1, 6))).toMatchObject({
      title: "Shir",
      market: "il",
      artist_rank: 1,
      tier: 0,
    });
    expect(byId(uuid(1, 8))).toMatchObject({ title: "Ani Ve'Ata", market: "il", tier: 0 });
    // Hebrew, unplaced artist, not curated: Israeli market, but not a hit.
    expect(byId(uuid(1, 14))).toMatchObject({ market: "il", tier: 2 });
    const info = a.steps.find((s) => s.step === "hits")?.info as {
      unmatchedPins: string[];
      curatedArtists: number;
    };
    expect(info.curatedArtists).toBe(2);
    expect(info.unmatchedPins).toEqual([`${uuid(4, 2)}: No Such Song`]);
  });

  it("marks tiers: hits, deep cuts by artists with a hit, the rest", () => {
    for (const t of tracks) {
      expect([0, 1, 2]).toContain(t.tier);
      expect(Number(t.hit_pct)).toBeGreaterThanOrEqual(0);
      expect(Number(t.hit_pct)).toBeLessThanOrEqual(1);
    }
    const artistOf = (t: Record<string, unknown>) => (t.artist_mbids as string[])[0];
    const hitArtists = new Set(tracks.filter((t) => t.tier === 0).map(artistOf));
    expect(hitArtists.size).toBeGreaterThan(0);
    for (const t of tracks) {
      if (t.tier === 0) expect(Number(t.artist_rank)).toBeLessThanOrEqual(3);
      if (t.tier === 1) expect(hitArtists.has(artistOf(t))).toBe(true);
      if (t.tier === 2) expect(hitArtists.has(artistOf(t))).toBe(false);
    }
  });

  it("maps tags to clusters and keeps every scalar in [-1, 1]", () => {
    const clusters = byId(uuid(1, 1))?.clusters as
      | { key: string; value: number }[]
      | Map<string, number>
      | Record<string, number>;
    expect(JSON.stringify(clusters)).toContain("classic_rock");
    for (const t of tracks) {
      for (const d of [
        "energy",
        "valence",
        "dance",
        "acoustic",
        "intensity",
        "tempo",
        "mainstream",
        "vocal",
        "complexity",
      ]) {
        const v = Number(t[d]);
        expect(v).toBeGreaterThanOrEqual(-1);
        expect(v).toBeLessThanOrEqual(1);
      }
      expect(Number(t.feature_confidence)).toBeGreaterThan(0);
    }
  });

  it("writes the manifest, license and report", async () => {
    expect(a.manifest).toMatchObject({
      kind: "full",
      catalog_version: "catalog-test",
      license: { id: "CC-BY-NC-SA-3.0-US" },
    });
    await access(path.join(a.outDir, "LICENSE.md"));
    const report = await readFile(a.reportFile, "utf8");
    expect(report).toContain("## Hebrew (IL) coverage");
    expect(report).toContain("Imputation");
  });

  it("is deterministic: an independent rebuild has the same digest", async () => {
    const b = await build("b", false);
    expect(b.manifest.digest).toBe(a.manifest.digest);
  }, 240_000);

  it("draws a dev sample and fixture that round-trip through fetch and readFixture", async () => {
    const db = await Db.open(":memory:", { threads: 2, memoryLimit: "1GB" });
    let sample: Awaited<ReturnType<typeof buildSamples>>;
    try {
      sample = await buildSamples(db, {
        catalogDir: a.outDir,
        outRoot: path.join(root, "samples"),
        fixtureDir: path.join(root, "fixture"),
        devSize: 50,
        fixtureSize: 10,
        devHebrewFloor: 2,
        fixtureHebrewFloor: 1,
      });
    } finally {
      db.close();
    }
    expect(sample.devTracks).toBe(50);
    const { manifest, dir } = await fetchSample({
      file: sample.devTar,
      outRoot: path.join(root, "installed"),
    });
    expect(manifest).toMatchObject({
      kind: "dev-sample",
      tracks: 50,
      derived_from: { digest: a.manifest.digest },
    });
    await access(path.join(dir, "tracks.parquet"));
    const fixture = await readFixture(sample.fixtureDir, true);
    expect(fixture.tracks).toHaveLength(10);
    expect(fixture.manifest.kind).toBe("fixture");
    expect(createHash("sha256").update(fixture.text).digest("hex")).toBe(fixture.manifest.digest);
    expect(fixture.tracks.some((t) => t.language === "lang_he" || t.artist_country === "IL")).toBe(
      true,
    );
    const devIds = new Set((await rows({ ...a, outDir: dir })).map((t) => t.track_id));
    for (const t of fixture.tracks) expect(devIds.has(t.track_id)).toBe(true);
  });

  it("fetches a sample over HTTP, checking the .sha256 sidecar", async () => {
    const tar = await readFile(path.join(root, "samples", "catalog-test-dev50.tar"));
    const sha = createHash("sha256").update(tar).digest("hex");
    const served: string[] = [];
    const fetchImpl: typeof fetch = async (url) => {
      served.push(String(url));
      if (String(url).endsWith(".sha256")) return new Response(`${sha}  catalog-test-dev50.tar\n`);
      return new Response(tar);
    };
    const out = path.join(root, "via-http");
    const { manifest } = await fetchSample({
      url: "https://example.test/catalog-test-dev50.tar",
      outRoot: out,
      fetchImpl,
    });
    expect(manifest.tracks).toBe(50);
    expect(served).toEqual([
      "https://example.test/catalog-test-dev50.tar.sha256",
      "https://example.test/catalog-test-dev50.tar",
    ]);
    const bad: typeof fetch = async (url) =>
      String(url).endsWith(".sha256") ? new Response(`${"1".repeat(64)}\n`) : new Response(tar);
    await expect(
      fetchSample({
        url: "https://example.test/x.tar",
        outRoot: path.join(root, "bad"),
        fetchImpl: bad,
      }),
    ).rejects.toThrow(/sha256/);
  });

  it("refuses a tampered sample", async () => {
    const tar = path.join(root, "samples", "catalog-test-dev50.tar");
    await expect(
      fetchSample({ file: tar, sha256: "0".repeat(64), outRoot: path.join(root, "x") }),
    ).rejects.toThrow(/sha256/);
  });

  it("ranks by API listener counts when the API is on, and caches them", async () => {
    const c = await build("c", true);
    expect(c.manifest.popularity.api).toBe(true);
    expect(c.manifest.tracks).toBe(100);
    const cached = await readFile(path.join(root, "api-c", "popularity.tsv"), "utf8");
    expect(cached.split("\n").filter(Boolean).length).toBeGreaterThan(200);
    // The seeded pool song nobody has in a top list was looked up; without the API it has no
    // known listeners, so it can't be ranked or used to fill the quota.
    expect(cached).toContain(uuid(1, 15));
    expect(byId(uuid(1, 15))).toBeUndefined();
  }, 240_000);
});
