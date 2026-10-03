import { readdirSync } from "node:fs";
import {
  type Bank,
  type Dimensions,
  EMPTY_ADJUST,
  MAX_TITLE_CHARS,
  type TasteVector,
} from "@abtune/engine";
import { describe, expect, it } from "vitest";
import {
  AiCache,
  type AiRuntime,
  aiSettings,
  answerLines,
  cleanText,
  ENRICH_DIMS,
  enrichTask,
  fitLine,
  interpretTask,
  loadPrompt,
  MAX_RESPONSE_BYTES,
  openaiCompat,
  PROMPTS_DIR,
  parsePrompt,
  RETRY_NOTE,
  render,
  rerankTask,
  runTask,
  spearman,
  tasteSummary,
  tweakTask,
} from "../src/index.ts";
import { MockProvider, type MockReply } from "../src/mock.ts";

const DIMS: Dimensions = {
  scalar: ["energy", "valence", "mainstream"],
  decades: ["dec80", "dec90", "dec00"],
  genres: ["classic_rock", "pop", "jazz", "metal"],
  languages: ["lang_en", "lang_he"],
};
const TASTE: TasteVector = {
  target: [60, -20, 60],
  weight: [80, 20, 12],
  decades: [600, 300, 100],
  genres: [500, 300, 150, 50],
  languages: [900, 100],
};
const BANK: Bank = {
  version: 1,
  dimensions: DIMS,
  packs: { core: { weight: 1, default: true }, spicy: { weight: 0.25, default: false } },
  questions: [
    {
      id: "rock_pop",
      pack: "core",
      pri: 90,
      weight: 1,
      a: { label: "Bon Jovi", emoji: "🎸", fx: { classic_rock: 1 } },
      b: { label: "Britney Spears", emoji: "💃", fx: { pop: 1 } },
    },
    {
      id: "fast_slow",
      pack: "core",
      pri: 80,
      weight: 1,
      q: 'Fast or "slow"?',
      a: { label: "Fast", emoji: "⚡", fx: { energy: 1 } },
      b: { label: "Slow", emoji: "🐢", fx: { energy: -1 } },
    },
  ],
};

const runtime = (provider: MockProvider, timeoutMs = 2000): AiRuntime & { lines: string[] } => {
  const lines: string[] = [];
  return { provider, timeoutMs, cache: new AiCache(), log: (l) => lines.push(l), lines };
};

const interpretInput = {
  dims: DIMS,
  taste: TASTE,
  answers: answerLines(BANK, [
    { id: "rock_pop", choice: "a" },
    { id: "fast_slow", choice: "both" },
  ]),
};

const goodInterpret = JSON.stringify({
  scalar_deltas: [{ dim: "energy", delta: 0.2 }],
  genre_boosts: [{ genre: "metal", boost: 0.4 }],
  decade_boosts: [],
  title: "Arena Rock Revival",
  blurb: "Big guitars, bigger choruses.",
});

describe("settings (.env)", () => {
  it("is off by default, and off with a reason when misconfigured", () => {
    expect(aiSettings({}).settings.provider).toBe("none");
    const noModel = aiSettings({ AI_PROVIDER: "openai_compat" });
    expect(noModel.settings.provider).toBe("none");
    expect(noModel.problems.map((p) => p.setting)).toEqual(["AI_MODEL"]);
    for (const p of ["openrouter", "anthropic"]) {
      const r = aiSettings({ AI_PROVIDER: p, AI_MODEL: "x" });
      expect(r.settings.provider).toBe("none");
      expect(r.problems[0]?.message).toMatch(/isn't supported in v0\.1/);
    }
    expect(aiSettings({ RERANK_BACKEND: "jev" }).problems[0]?.setting).toBe("RERANK_BACKEND");
  });

  it("reads a local server's settings", () => {
    const { settings, problems } = aiSettings({
      AI_PROVIDER: "openai_compat",
      AI_BASE_URL: "http://127.0.0.1:1234/v1/",
      AI_MODEL: "qwen",
      AI_TIMEOUT_MS: "30000",
      AI_REASONING_EFFORT: "none",
      RERANK_BACKEND: "llm",
      ALLOW_SENSITIVE_TO_AI: "true",
    });
    expect(problems).toEqual([]);
    expect(settings).toMatchObject({
      provider: "openai_compat",
      baseUrl: "http://127.0.0.1:1234/v1",
      model: "qwen",
      timeoutMs: 30000,
      reasoningEffort: "none",
      rerank: true,
      allowSensitive: true,
    });
    // Rerank needs a provider.
    expect(aiSettings({ RERANK_BACKEND: "llm" }).settings.rerank).toBe(false);
  });
});

describe("prompts (HANDOFF §10.5)", () => {
  it("every prompt file parses and has a version", () => {
    const names = readdirSync(PROMPTS_DIR).filter((f) => f.endsWith(".md"));
    expect(names.length).toBeGreaterThanOrEqual(3);
    for (const f of names) {
      const p = loadPrompt(f.replace(/\.md$/, ""));
      expect(p.version).toBeGreaterThanOrEqual(1);
      expect(p.system.length).toBeGreaterThan(100);
    }
  });

  it("render fills every placeholder and refuses gaps", () => {
    expect(render("a {{x}} b", { x: "1" })).toBe("a 1 b");
    expect(() => render("a {{x}} {{y}}", { x: "1" })).toThrow(/no value/);
    expect(() => render("a", { x: "1" })).toThrow(/isn't in the template/);
    expect(() => parsePrompt("p", "no front matter")).toThrow();
  });

  it("golden: the rendered interpret, tweak and rerank prompts", async () => {
    const t1 = interpretTask();
    await expect(
      `${t1.prompt.system}\n\n---\n\n${t1.user(interpretInput)}\n\n---\n\n${JSON.stringify(t1.schema(interpretInput), null, 2)}\n`,
    ).toMatchFileSnapshot("./golden/interpret.txt");
    const t3 = tweakTask();
    const tweakInput = { dims: DIMS, taste: TASTE, request: 'rainy Sunday, "slow" please' };
    await expect(`${t3.user(tweakInput)}\n`).toMatchFileSnapshot("./golden/tweak.txt");
    const t2 = rerankTask();
    const rerankInput = {
      dims: DIMS,
      taste: TASTE,
      n: 2,
      title: "Arena Rock Revival",
      blurb: null,
      songs: [
        { title: "Livin' on a Prayer", artist: "Bon Jovi", year: 1986, genre: "Classic Rock" },
        { title: "Toxic", artist: "Britney Spears", year: 2003, genre: "Pop" },
        { title: "So What", artist: "Miles Davis", year: null, genre: null },
      ],
    };
    await expect(
      `${t2.user(rerankInput)}\n\n---\n\n${JSON.stringify(t2.schema(rerankInput), null, 2)}\n`,
    ).toMatchFileSnapshot("./golden/rerank.txt");
  });

  it("describes the profile and answers in words", () => {
    const s = tasteSummary(DIMS, TASTE);
    expect(s).toContain(
      "Genres: Classic Rock [classic_rock] 50%, Pop [pop] 30%, Jazz [jazz] 15%, Metal [metal] 5%",
    );
    expect(s).toContain("energy (Calm ↔ Energetic): Energetic (+0.60, sure)");
    expect(tasteSummary(DIMS, { ...TASTE, genres: null, weight: [0, 0, 0] })).toContain(
      "Genres: no preference yet",
    );
    expect(interpretInput.answers).toEqual([
      '- chose "Bon Jovi" over "Britney Spears"',
      '- liked both "Fast" and "Slow" (asked: "Fast or \'slow\'?")',
    ]);
  });
});

describe("guardrails (HANDOFF §10.4)", () => {
  it("parses and clamps a good answer, then serves it from the cache", async () => {
    const mock = new MockProvider({ interpret: goodInterpret });
    const rt = runtime(mock);
    const r = await runTask(rt, interpretTask(), interpretInput);
    expect(r).toEqual({
      ok: true,
      cached: false,
      value: {
        adjust: { scalar: { energy: 20 }, genres: { metal: 40 }, decades: {} },
        title: "Arena Rock Revival",
        blurb: "Big guitars, bigger choruses.",
      },
    });
    const again = await runTask(rt, interpretTask(), interpretInput);
    expect(again.ok && again.cached).toBe(true);
    expect(mock.calls).toHaveLength(1);
  });

  it("retries an invalid answer once, with a note, then falls back", async () => {
    const mock = new MockProvider({ interpret: ["{not json", '{"title": 5}'] });
    const rt = runtime(mock);
    expect(await runTask(rt, interpretTask(), interpretInput)).toEqual({
      ok: false,
      failure: "invalid",
    });
    expect(mock.calls).toHaveLength(2);
    expect(mock.calls[1]?.user.endsWith(RETRY_NOTE)).toBe(true);
    expect(rt.lines).toEqual(["AI interpret: invalid"]);
    // A second chance that works counts.
    const fixed = new MockProvider({ interpret: ["[]", goodInterpret] });
    expect((await runTask(runtime(fixed), interpretTask(), interpretInput)).ok).toBe(true);
  });

  it("timeouts, dead servers and oversized answers fall back without a retry", async () => {
    const cases: [MockReply, string][] = [
      [{ hang: true }, "timeout"],
      [{ fail: "unreachable" }, "unreachable"],
      [{ fail: "http" }, "unreachable"],
      ["x".repeat(MAX_RESPONSE_BYTES + 1), "oversized"],
    ];
    for (const [reply, failure] of cases) {
      const mock = new MockProvider({ interpret: reply });
      const r = await runTask(runtime(mock, 50), interpretTask(), interpretInput);
      expect(r).toEqual({ ok: false, failure });
      expect(mock.calls).toHaveLength(1);
    }
  });

  it("drops what the model made up and keeps the rest", async () => {
    const mock = new MockProvider({
      interpret: JSON.stringify({
        scalar_deltas: [
          { dim: "energy", delta: 9 },
          { dim: "danceability", delta: 0.1 },
          { dim: "energy", delta: -0.3 },
        ],
        genre_boosts: [
          { genre: "polka", boost: 0.5 },
          { genre: "jazz", boost: -0.2 },
        ],
        decade_boosts: [{ decade: "dec80", boost: Number.MAX_VALUE }],
        title: `  "${"Very long title ".repeat(10)}"\u0007 `,
        extra: "ignored",
      }),
    });
    const r = await runTask(runtime(mock), interpretTask(), interpretInput);
    if (!r.ok) throw new Error(r.failure);
    expect(r.value.adjust).toEqual({
      scalar: { energy: 30 },
      genres: { jazz: -20 },
      decades: { dec80: 50 },
    });
    expect([...(r.value.title ?? "")].length).toBeLessThanOrEqual(MAX_TITLE_CHARS);
    expect(r.value.title).toMatch(/^Very long title.*…$/);
    expect(r.value.blurb).toBeNull();
  });

  it("an empty but valid answer means no change", async () => {
    const mock = new MockProvider({
      tweak:
        '```json\n{"scalar_deltas":[],"genre_boosts":[],"decade_boosts":[],"title":"","blurb":""}\n```',
    });
    const r = await runTask(runtime(mock), tweakTask(), {
      dims: DIMS,
      taste: TASTE,
      request: "hello",
    });
    expect(r).toEqual({
      ok: true,
      cached: false,
      value: { adjust: EMPTY_ADJUST, title: null, blurb: null },
    });
  });

  it("rerank keeps only real, distinct shortlist numbers", async () => {
    const songs = Array.from({ length: 5 }, (_, i) => ({
      title: `Song ${i}`,
      artist: `Artist ${i}`,
      year: 1990,
      genre: "Pop",
    }));
    const input = { dims: DIMS, taste: TASTE, songs, n: 3 };
    const mock = new MockProvider({
      rerank: JSON.stringify({
        picks: [
          { n: 4, why: "Fits the energy" },
          { n: 4, why: "again" },
          { n: 0, why: "no such song" },
          { n: 2.5, why: "half a song" },
          { n: 99, why: "made up" },
          { n: 1, why: "" },
        ],
      }),
    });
    const r = await runTask(runtime(mock), rerankTask(), input);
    expect(r).toEqual({
      ok: true,
      cached: false,
      value: { order: [3, 0], notes: { 3: "Fits the energy" } },
    });
    // The time limit grows with the playlist: 20 s per 25 songs.
    expect([25, 50, 100].map((n) => rerankTask().timeoutFactor?.({ ...input, n }))).toEqual([
      1, 2, 4,
    ]);
    const none = new MockProvider({ rerank: '{"picks":[{"n":42,"why":"x"}]}' });
    expect(await runTask(runtime(none), rerankTask(), input)).toEqual({
      ok: false,
      failure: "invalid",
    });
  });

  it("cleanText: one line, no controls, cut on a word", () => {
    expect(cleanText("  a\n\tb  ", 10)).toBe("a b");
    expect(cleanText("“quoted”", 10)).toBe("quoted");
    expect(cleanText("one two three four", 10)).toBe("one two…");
    expect(cleanText("   ", 10)).toBeNull();
    expect(cleanText(42, 10)).toBeNull();
  });
});

describe("openai_compat provider", () => {
  const settings = aiSettings({
    AI_PROVIDER: "openai_compat",
    AI_BASE_URL: "http://model.test/v1",
    AI_MODEL: "local-model",
    AI_API_KEY: "k",
    AI_REASONING_EFFORT: "none",
  }).settings;
  const ok = (content: string) =>
    new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
  const request = {
    task: "interpret",
    system: "sys",
    user: "usr",
    schema: { type: "object" },
    maxTokens: 100,
    signal: AbortSignal.timeout(1000),
  };

  it("asks for schema-constrained JSON at temperature 0", async () => {
    let seen: { url: string; init: RequestInit } | null = null;
    const p = openaiCompat({
      ...settings,
      fetch: async (url, init) => {
        seen = { url: String(url), init: init as RequestInit };
        return ok('{"a":1}');
      },
    });
    expect(await p.complete(request)).toBe('{"a":1}');
    const s = seen as unknown as { url: string; init: RequestInit };
    expect(s.url).toBe("http://model.test/v1/chat/completions");
    expect((s.init.headers as Record<string, string>).authorization).toBe("Bearer k");
    expect(JSON.parse(s.init.body as string)).toEqual({
      model: "local-model",
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "usr" },
      ],
      temperature: 0,
      seed: 42,
      max_tokens: 100,
      stream: false,
      response_format: {
        type: "json_schema",
        json_schema: { name: "interpret", strict: true, schema: { type: "object" } },
      },
      reasoning_effort: "none",
    });
  });

  it("maps server trouble to call errors", async () => {
    const kinds: [typeof fetch, string][] = [
      [async () => new Response("x".repeat(MAX_RESPONSE_BYTES + 10)), "oversized"],
      [async () => new Response("busy", { status: 503 }), "http"],
      [async () => new Response("<html>"), "http"],
      [async () => ok(""), "empty"],
      [
        async () => {
          throw new TypeError("fetch failed");
        },
        "unreachable",
      ],
      [
        async () => {
          throw new DOMException("timed out", "TimeoutError");
        },
        "timeout",
      ],
    ];
    for (const [f, kind] of kinds) {
      const p = openaiCompat({ ...settings, fetch: f });
      await expect(p.complete(request)).rejects.toMatchObject({ kind });
    }
  });
});

describe("T4 enrich", () => {
  const songs = [
    { title: "Smells Like Teen Spirit", artist: "Nirvana", year: 1991, genre: "Alt & Indie" },
    { title: "Clair de lune", artist: "Claude Debussy", year: null, genre: "Classical" },
    { title: "Unknown B-side", artist: "Nobody", year: 2024, genre: null },
  ];
  const rated = (n: number, v: number) => ({
    n,
    known: true,
    ...Object.fromEntries(ENRICH_DIMS.map((d) => [d, v])),
  });

  it("keeps ratings for known songs by number, and nulls for the rest", async () => {
    const mock = new MockProvider({
      enrich: JSON.stringify({
        songs: [
          rated(2, 1),
          rated(1, 5),
          { ...rated(3, 3), known: false },
          rated(1, 2), // a repeat: the first one counts
          rated(9, 4), // not in the batch
        ],
      }),
    });
    const r = await runTask(runtime(mock), enrichTask(), { songs });
    if (!r.ok) throw new Error(r.failure);
    expect(r.value[0]?.energy).toBe(5);
    expect(r.value[1]?.vocal).toBe(1);
    expect(r.value[2]).toBeNull();
    expect(mock.calls[0]?.user).toContain(
      "1. Smells Like Teen Spirit — Nirvana (1991, Alt & Indie)",
    );
    expect(mock.calls[0]?.user).toContain("3. Unknown B-side — Nobody (2024)");
  });

  it("rejects ratings outside 1–5", async () => {
    const mock = new MockProvider({ enrich: JSON.stringify({ songs: [rated(1, 7)] }) });
    expect(await runTask(runtime(mock), enrichTask(), { songs })).toEqual({
      ok: false,
      failure: "invalid",
    });
  });

  it("fits lines and ranks", () => {
    expect(fitLine([1, 2, 3, 4], [1, 3, 5, 7])).toEqual({ a: -1, b: 2 });
    expect(fitLine([2, 2, 2], [1, 2, 3])).toBeNull();
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1);
    expect(spearman([1, 1, 2, 2], [5, 6, 7, 8])).toBeGreaterThan(0.8);
  });
});
