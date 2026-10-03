// MCP server (HANDOFF §12, §16 #11): from "make me a playlist for a rainy Sunday" to an exported
// file using only the MCP tools, plus the interactive quiz, share codes and errors.
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import {
  authorizeUrl,
  entryKey,
  exchangeCode,
  newConnectionId,
  pkcePair,
  type SpotifySettings,
  spotifyConfig,
  TokenStore,
} from "@abtune/connectors/spotify";
import { FakeSpotify } from "@abtune/connectors/spotify/fake";
import {
  type Bank,
  chooseFromShortlist,
  encodeShare,
  engineVersion,
  firstStep,
  generate,
  type PlaylistTrack,
  playlistBase,
  playShortlist,
  type ShareData,
  shortlistLength,
} from "@abtune/engine";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CatalogHandle } from "../src/playlist.ts";
import { createServer, INSTRUCTIONS } from "../src/server.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

interface Result {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

let bank: Bank;
let client: Client;
let catalog: CatalogHandle;
let out: string;

beforeAll(async () => {
  const loaded = await loadBankFromDisk(["*.yaml"], { cwd: repo("data/questions") });
  if (!loaded.bank) throw new Error("bank failed to load");
  bank = loaded.bank;
  catalog = new CatalogHandle(repo("data/catalog"), repo("data/catalog-fixture"), bank.dimensions);
  out = await mkdtemp(path.join(tmpdir(), "abtune-mcp-"));
  const server = createServer({ bank, catalog, appBaseUrl: "http://127.0.0.1:8787/", cwd: out });
  const [a, b] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test", version: "1.0.0" });
  await Promise.all([server.connect(a), client.connect(b)]);
});

afterAll(async () => {
  await client.close();
  catalog.close();
  await rm(out, { recursive: true, force: true });
});

const call = async (name: string, args: Record<string, unknown>) =>
  (await client.callTool({ name, arguments: args })) as Result;
/** A successful result, with its structured content. */
const ok = (r: Result) => {
  expect(r.isError, r.content[0]?.text).toBeFalsy();
  return { ...r, structuredContent: r.structuredContent ?? {} };
};

describe("MCP server", () => {
  it("offers the HANDOFF §12 tools and explains the flow", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "answer",
      "export_playlist",
      "generate_playlist",
      "get_profile",
      "list_questions",
      "push_to_spotify",
      "start_quiz",
      "submit_answers",
    ]);
    expect(client.getInstructions()).toBe(INSTRUCTIONS);
  });

  it("§16 #11: a rainy-Sunday playlist from a description to an exported file", async () => {
    const list = ok(await call("list_questions", {}));
    const questions = list.structuredContent.questions as { id: string; a: string; b: string }[];
    expect(questions.length).toBeGreaterThan(50);
    // What a host model does with "music for a rainy Sunday": pick the side that fits, skip the rest.
    const cozy =
      /rain|cozy|slow|calm|chill|night in|tea|candle|acoustic|sad|stroll|winter|lo-fi|jazz|folk|ballad|crying|quiet/i;
    const answers = questions.map((q) => ({
      id: q.id,
      choice: cozy.test(q.a) ? "a" : cozy.test(q.b) ? "b" : "skip",
    }));
    expect(answers.filter((a) => a.choice !== "skip").length).toBeGreaterThan(5);
    const submitted = ok(await call("submit_answers", { answers, length: 25 }));
    const sessionId = submitted.structuredContent.session_id as string;
    expect(submitted.content[0]?.text).toMatch(/Archetype: /);
    expect(submitted.content[0]?.text).not.toContain(questions[0]?.id);

    const playlist = ok(await call("generate_playlist", { session_id: sessionId }));
    const s = playlist.structuredContent as {
      playlist_id: string;
      tracks: unknown[];
      share_url: string;
    };
    expect(s.tracks).toHaveLength(25);
    expect(s.share_url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/#s=[A-Za-z0-9_-]+$/);

    const exported = ok(
      await call("export_playlist", {
        playlist_id: s.playlist_id,
        format: "csv",
        path: "exports/",
      }),
    );
    const file = exported.structuredContent.path as string;
    expect(path.dirname(file)).toBe(path.join(out, "exports"));
    const csv = await readFile(file, "utf8");
    expect(csv.trim().split("\r\n")).toHaveLength(26);
  });

  it("plays the quiz card by card", async () => {
    const started = ok(await call("start_quiz", { mode: 10 }));
    const id = started.structuredContent.session_id as string;
    let r = started;
    for (let i = 0; i < 40 && !r.structuredContent.done; i++)
      r = ok(await call("answer", { session_id: id, choice: i % 2 ? "b" : "a" }));
    expect(r.structuredContent.done).toBe(true);
    expect(r.content[0]?.text).toMatch(/Built from 10 answers/);
    expect((await call("answer", { session_id: id, choice: "a" })).isError).toBe(true);
    const p = ok(await call("generate_playlist", { session_id: id, length: 10 }));
    expect((p.structuredContent.tracks as unknown[]).length).toBe(10);
  });

  it("rebuilds a playlist exactly from its share link, edits included", async () => {
    const s = ok(await call("start_quiz", { mode: 10 }));
    const id = s.structuredContent.session_id as string;
    for (let i = 0; i < 10; i++) await call("answer", { session_id: id, choice: "a" });
    const first = ok(
      await call("generate_playlist", {
        session_id: id,
        tweaks: ["more_energy", "newer"],
        deeper_cuts: 1,
      }),
    );
    const tracks = first.structuredContent.tracks as { track_id: string }[];
    expect(tracks).toHaveLength(50);
    const url = first.structuredContent.share_url as string;
    const again = ok(await call("generate_playlist", { share_code: url }));
    expect(
      (again.structuredContent.tracks as { track_id: string }[]).map((t) => t.track_id),
    ).toEqual(tracks.map((t) => t.track_id));
    const profile = ok(await call("get_profile", { share_code: url }));
    expect(profile.content[0]?.text).toMatch(/Built from 10 answers/);
    // A reshuffle is another playlist from the same profile.
    const shuffled = ok(await call("generate_playlist", { share_code: url, reshuffle: 1 }));
    expect(shuffled.content[0]?.text).toMatch(/dropped/);
    expect((shuffled.structuredContent.tracks as unknown[]).length).toBe(25);
  });

  it("rebuilds a web AI share: free-text adjustment, rerank picks and the AI title", async () => {
    const loaded = await catalog.get();
    const dims = bank.dimensions;
    const base: Omit<ShareData, "picks"> = {
      taste: {
        target: dims.scalar.map(() => 20),
        weight: dims.scalar.map(() => 60),
        decades: null,
        genres: null,
        languages: null,
      },
      tweaks: { mood: -1 },
      seed: "00000000deadbeef",
      length: 25,
      answered: 20,
      engineVersion: engineVersion(bank),
      catalogVersion: loaded.columns.version,
      ops: [],
      adjust: { scalar: { energy: -30 }, genres: { jazz: 40 }, decades: {} },
      title: "Rainy Sunday Jazz",
      blurb: "Slow and warm.",
    };
    // What the web server chose for a model that liked these shortlist songs.
    const first = firstStep(
      dims,
      playlistBase(dims, base.taste, base.adjust),
      base.tweaks,
      base.seed,
      25,
    );
    const short = generate(loaded.columns, first.taste, {
      length: shortlistLength(25),
      seed: base.seed,
    });
    const picks = chooseFromShortlist(loaded.columns, short.tracks, [70, 3, 41, 12], 25);
    const play = playShortlist(loaded.columns, short.tracks, picks, 25);
    const expected = (
      await loaded.meta(play.map((p) => (short.tracks[p] as PlaylistTrack).index))
    ).map((m) => m.track_id);
    const code = encodeShare(dims, { ...base, picks });
    const r = ok(await call("generate_playlist", { share_code: code }));
    expect((r.structuredContent.tracks as { track_id: string }[]).map((t) => t.track_id)).toEqual(
      expected,
    );
    expect(r.content[0]?.text).toContain("Rainy Sunday Jazz");
    // Another length reshapes the shortlist: the picks no longer apply.
    const longer = ok(await call("generate_playlist", { share_code: code, length: 50 }));
    expect(longer.content[0]?.text).toMatch(/AI's song picks were dropped/);
    expect((longer.structuredContent.tracks as unknown[]).length).toBe(50);
  });

  it("generates from a bare taste profile and exports inline", async () => {
    const sub = ok(
      await call("submit_answers", {
        answers: [
          { id: "bonjovi_britney", choice: "a" },
          { id: "dec80_dec90", choice: "a" },
        ],
      }),
    );
    const taste = sub.structuredContent.taste;
    const p = ok(await call("generate_playlist", { profile: taste, length: 5 }));
    const m3u = ok(
      await call("export_playlist", {
        playlist_id: p.structuredContent.playlist_id as string,
        format: "m3u",
      }),
    );
    expect(m3u.content[0]?.text.startsWith("#EXTM3U")).toBe(true);
  });

  it("explains what went wrong", async () => {
    const bad = await call("submit_answers", { answers: [{ id: "no_such_card", choice: "a" }] });
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toMatch(/no_such_card/);
    expect(
      (await call("submit_answers", { answers: [{ id: "dec80_dec90", choice: "skip" }] })).isError,
    ).toBe(true);
    expect((await call("generate_playlist", {})).isError).toBe(true);
    expect((await call("generate_playlist", { share_code: "#s=AAAA" })).isError).toBe(true);
    expect((await call("get_profile", { session_id: "nope" })).isError).toBe(true);
    expect((await call("export_playlist", { playlist_id: "nope", format: "csv" })).isError).toBe(
      true,
    );
    const spotify = await call("push_to_spotify", { playlist_id: "p1" });
    expect(spotify.isError).toBe(true);
    expect(spotify.content[0]?.text).toMatch(/export_playlist/);
  });
});

describe("push_to_spotify", () => {
  it("pushes with the connection the web app stored, and picks among several accounts", async () => {
    const all = await (await catalog.get()).meta(
      Array.from({ length: (await catalog.get()).columns.n }, (_, i) => i),
    );
    const fake = new FakeSpotify(
      all.map((m, i) => ({
        id: `sp${i}`,
        name: m.title,
        artists: [m.artist_credit],
        ...(m.isrcs[0] ? { isrc: m.isrcs[0] } : {}),
      })),
    );
    const settings: SpotifySettings = {
      clientId: fake.clientId,
      redirectUri: "http://127.0.0.1:8787/callback",
      secret: "mcp-test-secret-mcp-test-secret-0123456789",
      tokenFile: path.join(out, "spotify", "tokens.json"),
      accountsBase: "https://accounts.test",
      apiBase: "https://api.test/v1",
      fetch: fake.fetch,
      sleep: async () => {},
    };
    const cfg = spotifyConfig(settings);
    const store = new TokenStore(settings.tokenFile, settings.secret);
    /** What the web app's sign-in leaves in the store. */
    const connect = async (user: { id: string; display_name: string }, at: number) => {
      fake.user = user;
      const { verifier, challenge } = pkcePair();
      const res = await fake.handle(new Request(authorizeUrl(cfg, { state: "s", challenge })));
      const code = new URL(res.headers.get("location") as string).searchParams.get("code");
      const tokens = await exchangeCode(cfg, code as string, verifier);
      await store.write(entryKey(newConnectionId()), {
        ...tokens,
        user_id: user.id,
        display_name: user.display_name,
        connected_at: at,
      });
    };

    const server = createServer({ bank, catalog, spotify: settings, cwd: out });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const c = new Client({ name: "test", version: "1.0.0" });
    await Promise.all([server.connect(a), c.connect(b)]);
    const run = async (name: string, args: Record<string, unknown>) =>
      (await c.callTool({ name, arguments: args })) as Result;

    const sub = ok(
      await run("submit_answers", {
        answers: [
          { id: "bonjovi_britney", choice: "a" },
          { id: "dec80_dec90", choice: "a" },
        ],
      }),
    );
    const p = ok(await run("generate_playlist", { session_id: sub.structuredContent.session_id }));
    const playlist_id = p.structuredContent.playlist_id as string;

    const none = await run("push_to_spotify", { playlist_id });
    expect(none.isError).toBe(true);
    expect(none.content[0]?.text).toMatch(/No Spotify account is connected/);

    await connect({ id: "alice", display_name: "Alice" }, 1);
    const pushed = ok(await run("push_to_spotify", { playlist_id, name: "Rainy" }));
    expect(pushed.structuredContent).toMatchObject({ name: "Rainy", added: 25, account: "alice" });
    const [made] = [...fake.playlists.values()];
    expect(made).toMatchObject({ owner: "alice", public: false, name: "Rainy" });
    expect(made?.items).toHaveLength(25);
    expect(made?.description).toMatch(/Made with ABTune$/);

    await connect({ id: "bob", display_name: "Bob" }, 2);
    const which = await run("push_to_spotify", { playlist_id });
    expect(which.isError).toBe(true);
    expect(which.content[0]?.text).toMatch(/Several Spotify accounts/);
    expect(which.content[0]?.text).toMatch(/Alice \(alice\)/);
    expect(which.content[0]?.text).toMatch(/Bob \(bob\)/);
    ok(await run("push_to_spotify", { playlist_id, account: "bob" }));
    expect([...fake.playlists.values()].map((x) => x.owner).sort()).toEqual(["alice", "bob"]);
    await c.close();
  });
});
