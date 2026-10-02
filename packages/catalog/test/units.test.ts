import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { describe, expect, it } from "vitest";
import { NORMALIZE_MACROS } from "../src/build/songs.ts";
import { Db, lit } from "../src/db.ts";
import { Normal, solveRidge } from "../src/impute.ts";
import { fetchPopularity, readPopularityCache } from "../src/popularity-api.ts";
import { allocate, chooseSample, spreadPick } from "../src/sample.ts";
import { checkTagMap, loadTagMap, parseTagMap } from "../src/tagmap.ts";

const REPO = fileURLToPath(new URL("../../../", import.meta.url));

describe("tag map", () => {
  it("data/tag_map.yaml is valid against the seed bank's dimensions", async () => {
    const bank = await loadBankFromDisk(["*.yaml"], { cwd: path.join(REPO, "data/questions") });
    if (!bank.bank) throw new Error("bank failed to load");
    const map = await loadTagMap(path.join(REPO, "data/tag_map.yaml"));
    expect(checkTagMap(map.file, bank.bank.dimensions)).toEqual([]);
  });

  it("flags unknown keys, bad weights, thin clusters and overlaps", () => {
    const dims = { scalar: ["complexity"], decades: [], genres: ["pop", "jazz"], languages: [] };
    const file = parseTagMap(`version: 1
tags:
  pop: { pop: 1 }
  Jazz: { jazz: 1.5 }
  noise: { vibes: 1 }
non_music: [pop]
`);
    const issues = checkTagMap(file, dims, 1).map((i) => `${i.where}: ${i.message}`);
    expect(issues).toEqual(
      expect.arrayContaining([
        "tags.Jazz: tag must be lowercase and trimmed",
        "tags.Jazz: jazz: cluster weight 1.5 not in (0, 1]",
        'tags.noise: unknown key "vibes" (want a genre cluster or complexity/intensity)',
        'non_music: "pop" is also mapped to clusters',
      ]),
    );
  });
});

describe("ridge regression", () => {
  it("recovers known coefficients, deterministically", () => {
    const p = 3;
    const [t0, t1, t2] = [0.5, -2, 0.75];
    const truth = [t0, t1, t2];
    const fit = () => {
      const n = new Normal(p);
      let s = 1;
      for (let i = 0; i < 500; i++) {
        s = (s * 16807) % 2147483647;
        const a = (s % 1000) / 1000;
        s = (s * 16807) % 2147483647;
        const b = (s % 1000) / 1000;
        const x = [1, a, b];
        n.add(x, t0 + t1 * a + t2 * b);
      }
      return solveRidge(n.full(), n.b, p, 1e-9, [false, true, true]);
    };
    const beta = fit();
    beta.forEach((b, i) => {
      expect(b).toBeCloseTo(truth[i] ?? 0, 6);
    });
    expect([...fit()]).toEqual([...beta]);
  });

  it("shrinks penalized coefficients toward zero as λ grows", () => {
    const n = new Normal(2);
    for (let i = 0; i < 50; i++) n.add([1, i / 50], 3 * (i / 50));
    const small = solveRidge(n.full(), n.b, 2, 0.001, [false, true]);
    const big = solveRidge(n.full(), n.b, 2, 1000, [false, true]);
    expect(Math.abs(big[1] ?? 0)).toBeLessThan(Math.abs(small[1] ?? 0));
  });
});

describe("title normalization (DuckDB macros)", () => {
  const cases: [string, string, string, string][] = [
    // title, comment, expected key, expected version type
    ["Livin' on a Prayer", "", "livin on a prayer", "studio"],
    ["Livin' on a Prayer - 2011 Remaster", "", "livin on a prayer", "studio"],
    ["Livin' On A Prayer (Remastered 2011)", "", "livin on a prayer", "studio"],
    ["Livin' on a Prayer (Live at Wembley 1995)", "", "livin on a prayer", "live"],
    ["Livin' on a Prayer", "live, 1987-02-02: Tokyo", "livin on a prayer", "live"],
    ["Umbrella (feat. JAY-Z)", "", "umbrella", "studio"],
    ["Umbrella feat. JAY-Z", "", "umbrella", "studio"],
    ["Get Lucky (Radio Edit)", "", "get lucky", "studio"],
    ["Blue Monday '88 (Remix)", "", "blue monday 88 remix", "studio"],
    ["Live Forever", "", "live forever", "studio"],
    ["Beyoncé", "", "beyonce", "studio"],
    ["אני ואתה", "", "אני ואתה", "studio"],
    ["Кино", "", "кино", "studio"],
    ["?", "", "?", "studio"],
  ];
  it.each(cases)("%s / %s → %s (%s)", async (title, comment, key, version) => {
    const db = await Db.open(":memory:", { threads: 1, memoryLimit: "256MB" });
    try {
      await db.run(NORMALIZE_MACROS);
      const r = await db.one<{ k: string; v: string }>(
        `SELECT norm_title(${lit(title)}) AS k, version_type(${lit(title)}, ${lit(comment)}) AS v`,
      );
      expect(r).toEqual({ k: key, v: version });
    } finally {
      db.close();
    }
  });
});

describe("popularity API client", () => {
  it("batches ≤1000, honors 429 and rate-limit headers, retries 5xx, resumes from cache", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "abtune-api-"));
    const mbids = Array.from(
      { length: 2500 },
      (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, "0")}`,
    );
    const calls: number[] = [];
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      n++;
      if (n === 1)
        return new Response("slow down", { status: 429, headers: { "retry-after": "3" } });
      if (n === 2) return new Response("oops", { status: 503 });
      const { recording_mbids } = JSON.parse(String(init?.body)) as { recording_mbids: string[] };
      calls.push(recording_mbids.length);
      const body = recording_mbids.map((m, i) => ({
        recording_mbid: m,
        total_user_count: i % 7 === 0 ? null : i,
        total_listen_count: i % 7 === 0 ? null : i * 10,
      }));
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: {
          "x-ratelimit-remaining": calls.length === 1 ? "0" : "10",
          "x-ratelimit-reset-in": "4",
        },
      });
    };
    const sleep = async (ms: number) => {
      sleeps.push(ms);
    };
    const first = await fetchPopularity(mbids.slice(0, 1500), { cacheDir: dir, fetchImpl, sleep });
    expect(first.fetched).toBe(1500);
    expect(calls).toEqual([1000, 500]);
    expect(sleeps).toEqual([3000, 2000, 4500]); // Retry-After, 5xx backoff (2nd attempt), window exhausted
    const second = await fetchPopularity(mbids, { cacheDir: dir, fetchImpl, sleep });
    expect(second.fetched).toBe(1000);
    expect(calls).toEqual([1000, 500, 1000]);
    const cache = await readPopularityCache(dir);
    expect(cache.size).toBe(2500);
    expect(cache.get(mbids[0] ?? "")).toEqual({ gid: mbids[0], users: null, listens: null });
    expect(cache.get(mbids[1] ?? "")).toEqual({ gid: mbids[1], users: 1, listens: 10 });
  });
});

describe("sampling", () => {
  it("spreadPick takes the top half and spaces the rest evenly", () => {
    expect(spreadPick(10, 4)).toEqual([0, 1, 4, 8]);
    expect(spreadPick(3, 5)).toEqual([0, 1, 2]);
    expect(spreadPick(10, 0)).toEqual([]);
    expect(new Set(spreadPick(1000, 37)).size).toBe(37);
  });

  it("allocate is exact, proportional and gives every group at least one", () => {
    const out = allocate([1000, 10, 1, 0], 100);
    expect(out.reduce((a, b) => a + b, 0)).toBe(100);
    expect(out[2]).toBe(1);
    expect(out[3]).toBe(0);
    expect(out[0]).toBeGreaterThan(90);
  });

  it("chooseSample reserves the Hebrew floor, then fills strata to the exact size", () => {
    const ranked = Array.from({ length: 1000 }, (_, i) => ({
      id: `t${String(i).padStart(4, "0")}`,
      stratum: ["pop|dec80", "rock|dec90", "jazz|dec50"][i % 3] ?? "",
      hebrew: i % 50 === 0,
    }));
    const chosen = chooseSample(ranked, 100, 10);
    expect(chosen.size).toBe(100);
    expect(ranked.filter((r) => r.hebrew && chosen.has(r.id)).length).toBeGreaterThanOrEqual(10);
    expect([...chooseSample(ranked, 100, 10)]).toEqual([...chosen]);
  });
});
