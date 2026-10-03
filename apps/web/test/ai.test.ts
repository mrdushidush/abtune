// The AI layer on the server (HANDOFF §10, M7) with a mock model: §16 #8 (malformed, oversized and
// hallucinated answers still give a valid playlist of catalog songs) and §16 #9 (sensitive answers
// never reach the model without the opt-in, nor the logs).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { AI_OFF, AiCache, type AiSettings, MAX_RESPONSE_BYTES, MAX_TWEAK_TEXT } from "@abtune/ai";
import { MockProvider, type MockReply } from "@abtune/ai/mock";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { CatalogManifest } from "@abtune/catalog";
import { loadCatalog } from "@abtune/catalog/reader";
import {
  type AnswerEvent,
  answersForAi,
  applyAdjust,
  type Bank,
  checkPlaylist,
  createSession,
  decodeShare,
  encodeShare,
  engineVersion,
  foldProfile,
  reduceSession,
  type SessionState,
  type ShareData,
  type TasteVector,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AiAdjustResponse,
  type ApiError,
  type Health,
  MAX_AI_TEXT,
  type PlaylistRequest,
  type PlaylistResponse,
} from "../src/api-types.ts";
import { aiView, interpretRequest } from "../src/client/state/ai.ts";
import { type ApiResult, buildPlaylistRequest } from "../src/client/state/api.ts";
import {
  type AiState,
  type AppState,
  appReducer,
  EMPTY_STATE,
  restoreState,
} from "../src/client/state/app.ts";
import { applyEdit, editRequest, replayShare } from "../src/client/state/share.ts";
import { createApp } from "../src/server/app.ts";
import { catalogInfo, catalogSlot } from "../src/server/catalog.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

const GOOD_INTERPRET = JSON.stringify({
  scalar_deltas: [{ dim: "energy", delta: 0.2 }],
  genre_boosts: [{ genre: "classic_rock", boost: 0.3 }],
  decade_boosts: [{ decade: "dec80", boost: 0.2 }],
  title: "Big Hair, Bigger Choruses",
  blurb: "You picked the loud side almost every time.",
});

describe("AI layer on the server", async () => {
  const { bank: loadedBank } = await loadBankFromDisk(["*.yaml"], { cwd: repo("data/questions") });
  if (!loadedBank) throw new Error("bank failed to load");
  const bank: Bank = loadedBank;
  const engine = engineVersion(bank);
  const dir = repo("data/catalog-fixture");
  const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8")) as CatalogManifest;
  const loaded = await loadCatalog(dir, bank.dimensions, { threads: 2 });
  afterAll(() => loaded.close());
  const info = catalogInfo(manifest);
  const slot = catalogSlot(info, Promise.resolve(loaded));
  await slot.settled;

  const sensitiveIds = bank.questions.filter((q) => q.sensitive).map((q) => q.id);
  expect(sensitiveIds).toContain("trump_obama");
  // A log with the political card in it, plus ordinary answers and a skip.
  const log: AnswerEvent[] = [
    { id: "bonjovi_britney", choice: "a" },
    { id: "trump_obama", choice: "a" },
    { id: "dancefloor_carcry", choice: "b" },
    { id: "guitar_synth", choice: "skip" },
    { id: "fresh_timeless", choice: "both" },
  ];
  const taste: TasteVector = tasteVector(bank, foldProfile(bank, log));
  const SENSITIVE_WORDS = ["Trump", "Obama", "trump_obama", "political"];

  /** A server with a mock model; `logs` collects everything the AI layer would log. */
  function server(
    script: ConstructorParameters<typeof MockProvider>[0],
    over: Partial<AiSettings> = {},
    timeoutMs = 300,
  ) {
    const mock = new MockProvider(script);
    const logs: string[] = [];
    const settings: AiSettings = {
      ...AI_OFF,
      provider: "openai_compat",
      model: "mock",
      rerank: true,
      ...over,
    };
    const app = createApp({
      bank,
      version: "9.9.9",
      catalog: slot,
      ai: {
        settings,
        runtime: { provider: mock, timeoutMs, cache: new AiCache(), log: (l) => logs.push(l) },
      },
    });
    const post = async <T>(url: string, body: unknown) => {
      const res = await app.request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as T };
    };
    return { app, mock, logs, post };
  }

  const firstRequest = (t: TasteVector, length = 25): PlaylistRequest => ({
    taste: t,
    seed: "0123456789abcdef",
    length,
    engine_version: engine,
    catalog_version: info.version,
  });

  /** §9.3 and catalog membership: what every playlist must satisfy, AI or not. */
  function expectValid(res: PlaylistResponse, length: number) {
    const idx = res.tracks.map((t) => loaded.indexOf(t.track_id));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(checkPlaylist(loaded.columns, idx, length)).toEqual([]);
  }

  it("health reports the AI layer; off by default", async () => {
    const off = createApp({ bank, version: "9.9.9", catalog: slot });
    const h = (await (await off.request("/api/health")).json()) as Health;
    expect(h.ai).toEqual({ enabled: false, rerank: false, sensitive_opt_in: false, model: null });
    const on = server({});
    const h2 = (await (await on.app.request("/api/health")).json()) as Health;
    expect(h2.ai).toEqual({ enabled: true, rerank: true, sensitive_opt_in: false, model: "mock" });
    const res = await off.request("/api/ai/interpret", {
      method: "POST",
      body: JSON.stringify({ engine_version: engine, answers: [], taste }),
    });
    expect(res.status).toBe(503);
    expect(((await res.json()) as ApiError).error).toBe("ai_off");
  });

  it("interpret: a bounded adjustment, title and blurb", async () => {
    const s = server({ interpret: GOOD_INTERPRET });
    const r = await s.post<AiAdjustResponse>("/api/ai/interpret", {
      engine_version: engine,
      answers: log,
      taste,
    });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({
      adjust: { scalar: { energy: 20 }, genres: { classic_rock: 30 }, decades: { dec80: 20 } },
      title: "Big Hair, Bigger Choruses",
      blurb: "You picked the loud side almost every time.",
      sent: { answers: 3, sensitive: 0 },
    });
    const user = s.mock.calls[0]?.user ?? "";
    expect(user).toContain('chose "Bon Jovi" over "Britney Spears"');
    expect(user).toContain("Answers (3):");
    // The playlist for the adjusted taste is an ordinary one.
    const adjusted = applyAdjust(bank.dimensions, taste, r.body.adjust);
    const p = await s.post<PlaylistResponse>("/api/playlist", firstRequest(adjusted));
    expect(p.status).toBe(200);
    expectValid(p.body, 25);
  });

  it("checks the engine version, the origin and the body", async () => {
    const s = server({ interpret: GOOD_INTERPRET, tweak: GOOD_INTERPRET });
    const stale = await s.post<ApiError>("/api/ai/interpret", {
      engine_version: "0.0.1",
      answers: log,
      taste,
    });
    expect([stale.status, stale.body.error]).toEqual([409, "version_mismatch"]);
    const cross = await s.app.request("/api/ai/tweak", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ engine_version: engine, text: "run", taste }),
    });
    expect(cross.status).toBe(403);
    for (const body of [
      { engine_version: engine, answers: [{ id: "x", choice: "maybe" }], taste },
      { engine_version: engine, answers: log, taste: { ...taste, target: [999] } },
      { engine_version: engine, answers: log, taste, include_sensitive: "yes" },
    ]) {
      expect((await s.post("/api/ai/interpret", body)).status).toBe(400);
    }
    for (const text of ["", "   ", 42, "x".repeat(2000)]) {
      expect((await s.post("/api/ai/tweak", { engine_version: engine, text, taste })).status).toBe(
        400,
      );
    }
    expect(s.mock.calls).toHaveLength(0);
  });

  describe("§16 #9: sensitive answers stay out of AI payloads and logs", () => {
    const seen: string[] = [];
    beforeEach(() => {
      seen.length = 0;
      for (const m of ["log", "error", "warn", "info", "debug"] as const)
        vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
          seen.push(args.map(String).join(" "));
        });
    });
    afterEach(() => vi.restoreAllMocks());

    const leaks = (texts: readonly string[]) =>
      texts.filter((t) => SENSITIVE_WORDS.some((w) => t.includes(w)));

    it("the browser's filter drops them without the opt-in", () => {
      expect(answersForAi(bank, log, false).map((a) => a.id)).toEqual([
        "bonjovi_britney",
        "dancefloor_carcry",
        "fresh_timeless",
      ]);
      expect(answersForAi(bank, log, true).map((a) => a.id)).toContain("trump_obama");
    });

    it("the server drops them even if a client sends them, unless both opt-ins agree", async () => {
      for (const [allow, include] of [
        [false, false],
        [false, true],
        [true, false],
      ] as const) {
        const s = server(
          { interpret: "{broken", tweak: GOOD_INTERPRET },
          { allowSensitive: allow },
        );
        const r = await s.post<AiAdjustResponse | ApiError>("/api/ai/interpret", {
          engine_version: engine,
          answers: log,
          taste,
          include_sensitive: include,
        });
        // Even a failing model (two attempts) never saw them.
        expect(r.status).toBe(502);
        expect(s.mock.calls).toHaveLength(2);
        const payloads = s.mock.calls.flatMap((c) => [c.system, c.user, JSON.stringify(c.schema)]);
        expect(leaks(payloads)).toEqual([]);
        expect(leaks([...s.logs, ...seen])).toEqual([]);
      }
    });

    it("positive control: with both opt-ins, the answer goes, and is counted", async () => {
      const s = server({ interpret: GOOD_INTERPRET }, { allowSensitive: true });
      const r = await s.post<AiAdjustResponse>("/api/ai/interpret", {
        engine_version: engine,
        answers: log,
        taste,
        include_sensitive: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.sent).toEqual({ answers: 4, sensitive: 1 });
      expect(s.mock.calls[0]?.user).toContain('chose "Trump" over "Obama"');
      expect(leaks([...s.logs, ...seen])).toEqual([]);
    });

    it("playlist and rerank requests carry no answers, and log nothing about them", async () => {
      const s = server({ rerank: "{not json" });
      const r = await s.post<PlaylistResponse>("/api/playlist", {
        ...firstRequest(taste),
        rerank: true,
      });
      expect(r.status).toBe(200);
      const payloads = s.mock.calls.flatMap((c) => [c.system, c.user]);
      expect(leaks(payloads)).toEqual([]);
      expect(leaks([...s.logs, ...seen])).toEqual([]);
      expect(s.logs).toEqual(["AI rerank: invalid"]);
    });
  });

  describe("§16 #8: malformed, oversized and hallucinated answers", () => {
    const BAD: [string, MockReply][] = [
      ["not JSON", "here is your playlist!"],
      ["a JSON array", "[1, 2, 3]"],
      ["wrong types", '{"scalar_deltas": "lots", "title": 7}'],
      ["oversized", `{"title": "${"x".repeat(MAX_RESPONSE_BYTES)}"}`],
      ["a timeout", { hang: true }],
      ["a dead server", { fail: "unreachable" }],
      ["an empty answer", { fail: "empty" }],
    ];

    it.each(BAD)("interpret and tweak with %s fall back cleanly", async (_, reply) => {
      const s = server({ interpret: reply, tweak: reply });
      for (const [url, body] of [
        ["/api/ai/interpret", { engine_version: engine, answers: log, taste }],
        ["/api/ai/tweak", { engine_version: engine, text: "for a 5k run", taste }],
      ] as const) {
        const r = await s.post<ApiError>(url, body);
        expect(r.status).toBe(502);
        expect(r.body.error).toBe("ai_failed");
        expect(["invalid", "oversized", "timeout", "unreachable"]).toContain(r.body.reason);
      }
      // The classic playlist is still there.
      const p = await s.post<PlaylistResponse>("/api/playlist", firstRequest(taste));
      expectValid(p.body, 25);
    });

    it("out-of-range values and invented keys are clamped or dropped", async () => {
      const s = server({
        interpret: JSON.stringify({
          scalar_deltas: [
            { dim: "energy", delta: 50 },
            { dim: "loudness", delta: 0.3 },
          ],
          genre_boosts: [
            { genre: "yacht_rock", boost: 0.5 },
            { genre: "metal", boost: -9 },
          ],
          decade_boosts: [{ decade: "dec40", boost: 0.5 }],
          title: "",
          blurb: "\u0000",
        }),
      });
      const r = await s.post<AiAdjustResponse>("/api/ai/interpret", {
        engine_version: engine,
        answers: log,
        taste,
      });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({
        adjust: { scalar: { energy: 30 }, genres: { metal: -50 }, decades: {} },
        title: null,
        blurb: null,
      });
      const p = await s.post<PlaylistResponse>(
        "/api/playlist",
        firstRequest(applyAdjust(bank.dimensions, taste, r.body.adjust)),
      );
      expectValid(p.body, 25);
    });

    const RERANK_BAD: [string, MockReply][] = [
      ...BAD,
      [
        "only numbers outside the list",
        JSON.stringify({ picks: [{ n: 0 }, { n: 151 }, { n: -3 }] }),
      ],
      [
        "made-up track ids",
        JSON.stringify({
          picks: [{ n: "a3b1c2d4-0000-4000-8000-000000000000", why: "a song not in the catalog" }],
        }),
      ],
    ];

    it.each(RERANK_BAD)("rerank with %s gives the classic playlist", async (_, reply) => {
      const s = server({ rerank: reply });
      const classic = await s.post<PlaylistResponse>("/api/playlist", firstRequest(taste));
      const r = await s.post<PlaylistResponse>("/api/playlist", {
        ...firstRequest(taste),
        rerank: true,
      });
      expect(r.status).toBe(200);
      expect(r.body.rerank).not.toBe("done");
      expect(r.body.tracks).toEqual(classic.body.tracks);
      expect(r.body.picks).toBeUndefined();
      expectValid(r.body, 25);
    });

    it("a partly hallucinated rerank keeps the real picks and fills the rest", async () => {
      const s = server({
        rerank: JSON.stringify({
          picks: [
            { n: 75, why: "Last on the list, first in your heart" },
            { n: 75, why: "repeat" },
            { n: 9999, why: "not on the list" },
            { n: 2, why: "Big chorus, your kind of energy" },
          ],
        }),
      });
      const r = await s.post<PlaylistResponse>("/api/playlist", {
        ...firstRequest(taste),
        rerank: true,
        context: { title: "Big Hair, Bigger Choruses", blurb: "Loud." },
      });
      expect(r.status).toBe(200);
      expect(r.body.rerank).toBe("done");
      expectValid(r.body, 25);
      expect(r.body.picks).toHaveLength(25);
      expect(Object.values(r.body.notes ?? {})).toEqual(
        expect.arrayContaining(["Last on the list, first in your heart"]),
      );
      const call = s.mock.calls[0];
      expect(call?.user).toContain("Shortlist (75 songs)");
      expect(call?.user).toContain('Playlist: "Big Hair, Bigger Choruses"');
      // Replaying the picks needs no model and gives the same list.
      const replay = await s.post<PlaylistResponse>("/api/playlist", {
        ...firstRequest(taste),
        picks: r.body.picks,
      });
      expect(replay.body.tracks).toEqual(r.body.tracks);
      expect(replay.body.rerank).toBeUndefined();
      expect(s.mock.calls).toHaveLength(1);
    });

    it("picks from a link are checked like everything else", async () => {
      const s = server({});
      for (const picks of [[], [3, 2], [0, 150], [1.5], Array.from({ length: 26 }, (_, i) => i)]) {
        const r = await s.post("/api/playlist", { ...firstRequest(taste), picks });
        expect(r.status).toBe(400);
      }
      const both = await s.post("/api/playlist", {
        ...firstRequest(taste),
        picks: [1],
        rerank: true,
      });
      expect(both.status).toBe(400);
      // Forged but well-formed picks (all one artist, say) still give a §9.3-valid list.
      const r = await s.post<PlaylistResponse>("/api/playlist", {
        ...firstRequest(taste),
        picks: [0, 1, 2],
      });
      expect(r.status).toBe(200);
      expectValid(r.body, 25);
    });

    it("rerank is off unless RERANK_BACKEND=llm", async () => {
      const s = server({ rerank: "{}" }, { rerank: false });
      const r = await s.post<PlaylistResponse>("/api/playlist", {
        ...firstRequest(taste),
        rerank: true,
      });
      expect(r.body.rerank).toBe("off");
      expect(s.mock.calls).toHaveLength(0);
    });

    it("a client that leaves stops its rerank", async () => {
      // A model that never answers and a minute's time limit: only the client's abort ends it.
      const s = server({ rerank: { hang: true } }, {}, 60_000);
      const leave = new AbortController();
      const started = Date.now();
      const res = s.app.request("/api/playlist", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...firstRequest(taste), rerank: true }),
        signal: leave.signal,
      });
      await vi.waitFor(() => expect(s.mock.calls).toHaveLength(1));
      leave.abort();
      const body = (await (await res).json()) as PlaylistResponse;
      expect(body.rerank).toBe("timeout");
      expect(Date.now() - started).toBeLessThan(10_000);
      expect(s.mock.calls[0]?.signal.aborted).toBe(true);
    });
  });
  describe("in the browser", () => {
    /** A finished 10-answer session with AI on (always A; the spicy pack adds the political card). */
    function finished(packs?: string[]): SessionState {
      let st: SessionState = createSession(bank, {
        mode: 10,
        length: 25,
        ai: true,
        ...(packs ? { packs } : {}),
      });
      while (viewSession(bank, st).status === "asking")
        st = reduceSession(bank, st, { type: "answer", choice: "a" });
      return st;
    }
    const made = {
      adjust: { scalar: { valence: -20 }, genres: { jazz: 30 }, decades: {} },
      title: "Late Night Neon",
      blurb: "Moody synths after midnight.",
    };

    it("keeps the free-text limit in step with the server's", () => {
      expect(MAX_AI_TEXT).toBe(MAX_TWEAK_TEXT);
    });

    it("app state: AI from setup, interpretation per answer log, retry, text tweak, reload", () => {
      const setup = { mode: 10, length: 25, packs: ["core"], ai: true, aiSensitive: true };
      let st: AppState = appReducer(bank, EMPTY_STATE, {
        type: "start",
        setup,
        quizSeed: "00112233445566aa",
      });
      expect(st.session?.config.ai).toBe(true);
      expect(st.ai).toEqual({ optIn: true, key: null, interpret: null, text: null });
      st = appReducer(bank, st, {
        type: "ai_interpret",
        key: "0123456789abcdef",
        result: { status: "done", ...made, sensitive: false },
      });
      st = appReducer(bank, st, { type: "ai_text", text: { text: "after midnight", ...made } });
      const raw = JSON.stringify({ v: 1, engine_version: engine, state: st });
      expect(restoreState(bank, raw)).toEqual(st);
      // A tampered record is dropped, the session kept.
      const bad = JSON.parse(raw);
      bad.state.ai.text.adjust.scalar.valence = 99;
      expect(restoreState(bank, JSON.stringify(bad)).ai).toEqual({
        optIn: true,
        key: null,
        interpret: null,
        text: null,
      });
      st = appReducer(bank, st, { type: "ai_retry" });
      expect([st.ai?.key, st.ai?.interpret]).toEqual([null, null]);
      const off = appReducer(bank, EMPTY_STATE, {
        type: "start",
        setup: { mode: 10, length: 25, packs: ["core"] },
        quizSeed: "00112233445566aa",
      });
      expect(off.ai).toBeNull();
      expect(appReducer(bank, off, { type: "ai_text", text: null })).toBe(off);
    });

    it("aiView: waits for T1, then uses its card, title and the text tweak's base", () => {
      const session = finished();
      const none: AiState = { optIn: false, key: null, interpret: null, text: null };
      const waiting = aiView(bank, session, none, true);
      expect(waiting.pending).toBe(true);
      expect(aiView(bank, session, none, false).pending).toBe(false); // the server has no AI
      expect(aiView(bank, session, null, true).on).toBe(false);
      const engineTaste = tasteVector(bank, viewSession(bank, session).profile);
      const done: AiState = {
        ...none,
        key: waiting.key,
        interpret: { status: "done", ...made, sensitive: false },
        text: {
          text: "rainy",
          adjust: { scalar: { energy: -30 }, genres: {}, decades: {} },
          title: "Rainy Day",
          blurb: null,
        },
      };
      const v = aiView(bank, session, done, true);
      expect(v.pending).toBe(false);
      expect(v.card).toEqual(applyAdjust(bank.dimensions, engineTaste, made.adjust));
      expect(v.base).toEqual(
        applyAdjust(bank.dimensions, v.card, done.text?.adjust ?? made.adjust),
      );
      expect([v.title, v.blurb]).toEqual(["Rainy Day", made.blurb]);
      // New answers ("10 more") interpret again.
      const more = reduceSession(bank, session, { type: "ten_more" });
      expect(aiView(bank, more, done, true).pending).toBe(false);
      const answered = reduceSession(bank, more, { type: "answer", choice: "b" });
      expect(aiView(bank, answered, done, true).pending).toBe(true);
    });

    it("§16 #9: a title made from sensitive answers never goes in a share link", () => {
      const session = finished(["core", "spicy"]);
      const key = aiView(
        bank,
        session,
        { optIn: true, key: null, interpret: null, text: null },
        true,
      ).key;
      const ai: AiState = {
        optIn: true,
        key,
        interpret: { status: "done", ...made, sensitive: true },
        text: null,
      };
      const v = aiView(bank, session, ai, true);
      expect(v.title).toBe(made.title);
      expect([v.shareTitle, v.shareBlurb]).toEqual([null, null]);
      // The interpret request leaves sensitive answers out unless opted in.
      const log = [...session.answer_log, { id: "trump_obama", choice: "a" as const }];
      const withPolitics = { ...session, answer_log: log };
      expect(JSON.stringify(interpretRequest(bank, withPolitics, false))).not.toMatch(/trump/);
      expect(JSON.stringify(interpretRequest(bank, withPolitics, true))).toMatch(/trump_obama/);
      // And a share code from such a session decodes to no title, blurb or answers.
      const data: ShareData = {
        taste: v.card,
        tweaks: {},
        seed: "0123456789abcdef",
        length: 25,
        answered: 10,
        engineVersion: engine,
        catalogVersion: info.version,
        ops: [],
        ...(v.shareTitle ? { title: v.shareTitle } : {}),
      };
      const decoded = decodeShare(bank.dimensions, encodeShare(bank.dimensions, data));
      expect(decoded.title).toBeUndefined();
      expect(JSON.stringify(decoded)).not.toMatch(/Trump|Obama|trump_obama|Late Night/);
    });

    it("a share link replays the AI playlist (text tweak, rerank picks, edits) with no AI", async () => {
      const s = server({
        rerank: JSON.stringify({
          picks: [9, 3, 70, 41, 12].map((n) => ({ n, why: "Fits your late-night mood" })),
        }),
      });
      const session = finished();
      const key = aiView(
        bank,
        session,
        { optIn: false, key: null, interpret: null, text: null },
        true,
      ).key;
      const ai: AiState = {
        optIn: false,
        key,
        interpret: { status: "done", ...made, sensitive: false },
        text: {
          text: "after midnight",
          adjust: { scalar: { energy: -20 }, genres: {}, decades: { dec80: 40 } },
          title: null,
          blurb: null,
        },
      };
      const v = aiView(bank, session, ai, true);
      const first = buildPlaylistRequest(bank, session, { energy: 1 }, info.version, {
        base: v.base,
        rerank: true,
        context: { title: v.title ?? "" },
      });
      expect(first.rerank).toBe(true);
      const post = async (req: PlaylistRequest): Promise<ApiResult<PlaylistResponse>> => {
        const r = await s.post<PlaylistResponse>("/api/playlist", req);
        return r.status === 200
          ? { ok: true, data: r.body }
          : { ok: false, status: r.status, error: null };
      };
      const got = await post(first);
      if (!got.ok) throw new Error("first page failed");
      expect(got.data.rerank).toBe("done");
      expect(got.data.picks).toHaveLength(25);
      expect(Object.keys(got.data.notes ?? {}).length).toBeGreaterThan(0);
      expectValid(got.data, 25);
      // One "+25 deeper cuts", as the result screen makes it.
      const moreReq = editRequest(
        bank.dimensions,
        v.base,
        { energy: 1 },
        first,
        got.data.tracks,
        [],
        { op: "more" },
      );
      const more = await post(moreReq);
      if (!more.ok) throw new Error("more failed");
      const shown = applyEdit(got.data.tracks, { op: "more" }, more.data.tracks);
      const calls = s.mock.calls.length;

      const code = encodeShare(bank.dimensions, {
        taste: v.card,
        tweaks: { energy: 1 },
        seed: got.data.seed,
        length: 25,
        answered: 10,
        engineVersion: engine,
        catalogVersion: info.version,
        ops: [{ op: "more" }],
        ...(v.textAdjust ? { adjust: v.textAdjust } : {}),
        ...(got.data.picks ? { picks: got.data.picks } : {}),
        ...(v.shareTitle ? { title: v.shareTitle } : {}),
      });
      const data = decodeShare(bank.dimensions, code);
      expect(data.title).toBe(made.title);
      const replay = await replayShare(
        bank.dimensions,
        data,
        { engine_version: engine, catalog_version: info.version },
        post,
      );
      if (!replay.ok) throw new Error("replay failed");
      expect(replay.tracks.map((t) => t.track_id)).toEqual(shown.map((t) => t.track_id));
      expect(replay.skipped).toBe(0);
      expect(s.mock.calls.length).toBe(calls); // no AI on the way back
    });
  });
});
