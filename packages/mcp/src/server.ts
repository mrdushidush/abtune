// The ABTune MCP server (HANDOFF §12, M8). Tools for an MCP host (Claude Code): read the bank,
// play the quiz or answer it in one go, build, share and export playlists. Answers stay in this
// process; share links carry only the quantized profile (HANDOFF §13).
import { lstat, mkdir, realpath, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  EXPORT_FORMATS,
  type ExportFormat,
  type ExportPlaylist,
  exportPlaylist,
} from "@abtune/connectors";
import {
  type Connection,
  catalogBackfill,
  isSpotifyError,
  MatchCache,
  missingSettings,
  playlistDescription,
  pushPlaylist,
  SpotifyClient,
  type SpotifySettings,
  StoredTokens,
  spotifyConfig,
  TokenStore,
} from "@abtune/connectors/spotify";
import {
  type AnswerEvent,
  addTweak,
  archetypeName,
  type Bank,
  bankIndex,
  type Choice,
  clusterLabel,
  createSession,
  type Dimensions,
  decadeLabel,
  decodeShare,
  defaultPacks,
  encodeShare,
  engineVersion,
  firstStep,
  languageLabel,
  MORE_LENGTH,
  P_SCALE,
  playlistBase,
  playlistTitle,
  type Question,
  reduceSession,
  type SessionState,
  type ShareData,
  type ShareOp,
  scalarLabel,
  sessionSeed,
  sha256Hex,
  TARGET_SCALE,
  type TasteVector,
  TWEAK_IDS,
  type TweakId,
  type TweakSteps,
  tasteVector,
  traits,
  validateLog,
  validateTaste,
  viewSession,
} from "@abtune/engine";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { buildPlaylist, type CatalogHandle, type TrackRow } from "./playlist.ts";

export interface ServerOptions {
  readonly bank: Bank;
  readonly catalog: CatalogHandle;
  /** Where the web app runs, for share links (default http://127.0.0.1:8787). */
  readonly appBaseUrl?: string;
  readonly version?: string;
  /**
   * The export folder: relative export paths resolve here, and no export is written outside it
   * (EXPORT_DIR; default: the process's working directory).
   */
  readonly cwd?: string;
  /** Spotify settings from `.env`, as the web app's: push uses the connection made there. */
  readonly spotify?: SpotifySettings;
}

export const INSTRUCTIONS = `ABTune turns this-or-that answers into a music taste profile and a playlist of songs people know, from an open catalog.

To make a playlist from a description ("music for a rainy Sunday", "my dad likes 70s rock"):
1. list_questions.
2. For each question the description says something about, pick the side that fits: a, b, or both. Skip the rest; a skip adds nothing.
3. submit_answers with those answers. It returns a session_id and the profile.
4. generate_playlist with the session_id (optionally length, tweaks, deeper_cuts).
5. push_to_spotify (once Spotify is connected in the web app), export_playlist (m3u, csv, xspf or json), or give the user the share link.

To let the user play the quiz card by card instead: start_quiz, then answer each card.
Answers stay in this process. Share links carry only the quantized profile, never the answers.`;

const TRAITS = {
  energy: { hi: "High energy", lo: "Laid-back" },
  mood: { bright: "Bright", dark: "Dark" },
  era: { retro: "Retro", modern: "Modern" },
  texture: { organic: "Organic", electric: "Electric" },
} as const;

const text = (s: string, structured?: Record<string, unknown>): CallToolResult => ({
  content: [{ type: "text", text: s }],
  ...(structured ? { structuredContent: structured } : {}),
});
const fail = (s: string): CallToolResult => ({
  content: [{ type: "text", text: s }],
  isError: true,
});

const pct = (x: number) => `${Math.round((x / P_SCALE) * 100)}%`;

/** A readable profile summary (no answers in it). */
export function profileText(dims: Dimensions, taste: TasteVector, answered: number): string {
  const tr = traits(dims, taste);
  const lines = [
    `Archetype: ${archetypeName(tr)} (${[TRAITS.energy[tr.energy], TRAITS.mood[tr.mood], TRAITS.era[tr.era], TRAITS.texture[tr.texture]].join(", ")})`,
    `Built from ${answered} answer${answered === 1 ? "" : "s"}.`,
  ];
  const sound = dims.scalar.map((dim, i) => {
    const l = scalarLabel(dim);
    const v = (taste.target[i] ?? 0) / TARGET_SCALE;
    if ((taste.weight[i] ?? 0) < 30) return `${l.name}: not enough answers yet`;
    if (Math.abs(v) < 0.15) return `${l.name}: balanced`;
    return `${l.name}: ${v > 0 ? l.high : l.low} (${v > 0 ? "+" : ""}${v.toFixed(2)})`;
  });
  lines.push(`Sound: ${sound.join("; ")}`);
  const top = (
    keys: readonly string[],
    p: readonly number[] | null,
    n: number,
    label: (k: string) => string,
  ) =>
    p
      ? keys
          .map((k, i) => ({ k, x: p[i] ?? 0 }))
          .filter((e) => e.x >= 0.05 * P_SCALE)
          .sort((a, b) => b.x - a.x)
          .slice(0, n)
          .map((e) => `${label(e.k)} ${pct(e.x)}`)
          .join(", ")
      : "no preference";
  lines.push(`Top genres: ${top(dims.genres, taste.genres, 5, clusterLabel)}`);
  lines.push(`Era: ${top(dims.decades, taste.decades, 4, decadeLabel)}`);
  lines.push(`Languages: ${top(dims.languages, taste.languages, 3, languageLabel)}`);
  return lines.join("\n");
}

function questionLine(q: Question, deep: boolean): string {
  const ask = q.q ? ` ${q.q}` : "";
  return `${q.id} [${q.pack}${deep ? ", follow-up" : ""}]${ask} A: ${q.a.emoji} ${q.a.label} | B: ${q.b.emoji} ${q.b.label}`;
}

const choiceSchema = z.enum(["a", "b", "both", "skip"]);
const tweakSchema = z.enum(TWEAK_IDS as [TweakId, ...TweakId[]]);
const tasteSchema = z.object({
  target: z.array(z.number().int()),
  weight: z.array(z.number().int()),
  decades: z.array(z.number().int()).nullable(),
  genres: z.array(z.number().int()).nullable(),
  languages: z.array(z.number().int()).nullable(),
});

/** The extensions each export format may be saved with. */
const EXPORT_EXTS: Record<ExportFormat, readonly string[]> = {
  m3u: [".m3u8", ".m3u"],
  csv: [".csv"],
  xspf: [".xspf"],
  json: [".json"],
};

/** `file` is `dir` or inside it (both absolute). */
function inside(dir: string, file: string): boolean {
  const rel = path.relative(dir, file);
  return rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

interface Playlist {
  readonly id: string;
  readonly data: ShareData;
  readonly title: string;
  readonly description: string;
  readonly tracks: readonly TrackRow[];
}

export function createServer(opts: ServerOptions): McpServer {
  const { bank } = opts;
  const dims = bank.dimensions;
  const base = (opts.appBaseUrl ?? "http://127.0.0.1:8787").replace(/\/+$/, "");
  const cwd = opts.cwd ?? process.cwd();
  const engine = engineVersion(bank);
  const byId = bankIndex(bank).byId;
  const sessions = new Map<string, SessionState>();
  const playlists = new Map<string, Playlist>();
  const counters = new Map<string, number>();
  const newId = (prefix: string) => {
    const n = (counters.get(prefix) ?? 0) + 1;
    counters.set(prefix, n);
    return `${prefix}${n}`;
  };

  const server = new McpServer(
    { name: "abtune", version: opts.version ?? "0.1.0" },
    { instructions: INSTRUCTIONS },
  );

  const cardText = (s: SessionState) => {
    const v = viewSession(bank, s);
    if (v.status === "asking" && v.question)
      return {
        done: false,
        text: `Card ${v.position} of ${v.mode}: ${v.question.q ?? `${v.question.a.label} or ${v.question.b.label}?`}\nA: ${v.question.a.emoji} ${v.question.a.label}\nB: ${v.question.b.emoji} ${v.question.b.label}\nAnswer with a, b, both or skip.`,
        question: {
          id: v.question.id,
          a: v.question.a.label,
          b: v.question.b.label,
          q: v.question.q ?? null,
        },
        position: v.position,
      };
    const ended =
      v.status === "exhausted" ? "The bank ran out of questions for these packs." : "Done!";
    return {
      done: true,
      text: `${ended}\n${profileText(dims, tasteVector(bank, v.profile), v.answered)}\nNext: generate_playlist with this session_id.`,
      question: null,
      position: v.position,
    };
  };

  server.registerTool(
    "list_questions",
    {
      title: "List quiz questions",
      description:
        "The question bank: each question's id, pack and its two sides. Use it to answer the quiz for the user with submit_answers. Interchangeable variants and the opt-in spicy pack are left out unless asked for.",
      inputSchema: {
        pack: z
          .string()
          .optional()
          .describe("Only this pack (core, context, deep, vibe, il, spicy, …)."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .describe("Most questions to return, by priority (default 150)."),
        include_variants: z
          .boolean()
          .optional()
          .describe("Also list variants (other wordings of the same question)."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ pack, limit, include_variants }) => {
      const packs = pack ? new Set([pack]) : new Set(defaultPacks(bank));
      if (pack && !(pack in bank.packs))
        return fail(`Unknown pack "${pack}". Packs: ${Object.keys(bank.packs).join(", ")}.`);
      const list = bank.questions
        .filter((q) => packs.has(q.pack) && (include_variants || q.family === undefined))
        .sort((a, b) => b.pri - a.pri || (a.id < b.id ? -1 : 1))
        .slice(0, limit ?? 150);
      return text(
        `${list.length} questions (id [pack] question A | B). "follow-up" questions only make sense when the earlier answers point that way; skip them otherwise.\n${list
          .map((q) => questionLine(q, !!q.unlock_if))
          .join("\n")}`,
        {
          questions: list.map((q) => ({
            id: q.id,
            pack: q.pack,
            q: q.q ?? null,
            a: q.a.label,
            b: q.b.label,
            follow_up: !!q.unlock_if,
          })),
        },
      );
    },
  );

  server.registerTool(
    "start_quiz",
    {
      title: "Start a quiz",
      description:
        "Start an interactive quiz session and get the first card. Then call answer for each card until it says Done.",
      inputSchema: {
        mode: z.number().int().min(1).max(400).describe("Answers to collect: 10, 20, 50 or 100."),
        length: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Playlist length (default 25)."),
        packs: z
          .array(z.string())
          .optional()
          .describe("Question packs (default: core, context, deep, vibe, il)."),
      },
    },
    async ({ mode, length, packs }) => {
      let state: SessionState;
      try {
        state = createSession(bank, {
          mode,
          length: length ?? 25,
          packs: packs ?? defaultPacks(bank),
          quiz_seed: sha256Hex(`${Date.now()}:${Math.random()}`).slice(0, 16),
        });
      } catch (err) {
        return fail((err as Error).message);
      }
      const id = newId("s");
      sessions.set(id, state);
      const card = cardText(state);
      return text(`session_id: ${id}\n${card.text}`, { session_id: id, ...card });
    },
  );

  server.registerTool(
    "answer",
    {
      title: "Answer the current card",
      description:
        "Answer the current card of a quiz session: a, b, both or skip. Returns the next card, or the profile when done.",
      inputSchema: { session_id: z.string(), choice: choiceSchema },
    },
    async ({ session_id, choice }) => {
      const s = sessions.get(session_id);
      if (!s)
        return fail(`No session "${session_id}". Start one with start_quiz or submit_answers.`);
      if (viewSession(bank, s).status !== "asking")
        return fail("This quiz is finished. Call generate_playlist with its session_id.");
      const next = reduceSession(bank, s, { type: "answer", choice: choice as Choice });
      sessions.set(session_id, next);
      const card = cardText(next);
      return text(card.text, { session_id, ...card });
    },
  );

  server.registerTool(
    "submit_answers",
    {
      title: "Submit a whole quiz",
      description:
        "Answer the quiz in one call, for example on the user's behalf from a description of what they want. Use ids from list_questions. Returns a session_id and the taste profile.",
      inputSchema: {
        answers: z
          .array(z.object({ id: z.string(), choice: choiceSchema }))
          .min(1)
          .max(500),
        length: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Playlist length (default 25)."),
      },
    },
    async ({ answers, length }) => {
      const log: AnswerEvent[] = answers.map((a) => ({ id: a.id, choice: a.choice as Choice }));
      const unknown = log.filter((e) => !byId.has(e.id)).map((e) => e.id);
      if (unknown.length)
        return fail(`Unknown question ids: ${unknown.join(", ")}. Use ids from list_questions.`);
      try {
        validateLog(bank, log);
      } catch (err) {
        return fail((err as Error).message);
      }
      const answered = log.filter((e) => e.choice !== "skip").length;
      if (answered === 0) return fail("Every answer was a skip, so there's no profile to build.");
      const packs = new Set(defaultPacks(bank));
      for (const e of log) packs.add((byId.get(e.id) as Question).pack);
      const state: SessionState = {
        ...createSession(bank, { mode: answered, length: length ?? 25, packs: [...packs] }),
        answer_log: log,
      };
      const id = newId("s");
      sessions.set(id, state);
      const taste = tasteVector(bank, viewSession(bank, state).profile);
      return text(
        `session_id: ${id}\n${profileText(dims, taste, answered)}\nNext: generate_playlist with this session_id.`,
        { session_id: id, archetype: archetypeName(traits(dims, taste)), answered, taste },
      );
    },
  );

  const shareOf = (code: string) => {
    const m = code.match(/#s=([A-Za-z0-9_-]+)/);
    return decodeShare(dims, m ? (m[1] as string) : code.trim());
  };

  server.registerTool(
    "get_profile",
    {
      title: "Get a taste profile",
      description:
        "The music personality of a session or a share link: archetype, sound, genres, era, languages.",
      inputSchema: {
        session_id: z.string().optional(),
        share_code: z.string().optional().describe("A share code or a whole share link."),
      },
      annotations: { readOnlyHint: true },
    },
    async ({ session_id, share_code }) => {
      if (!session_id === !share_code) return fail("Pass exactly one of session_id or share_code.");
      let taste: TasteVector;
      let answered: number;
      if (session_id) {
        const s = sessions.get(session_id);
        if (!s) return fail(`No session "${session_id}".`);
        const v = viewSession(bank, s);
        taste = tasteVector(bank, v.profile);
        answered = v.answered;
      } else {
        try {
          const d = shareOf(share_code as string);
          taste = d.taste;
          answered = d.answered;
        } catch {
          return fail("That share code is broken or cut off.");
        }
      }
      return text(profileText(dims, taste, answered), {
        archetype: archetypeName(traits(dims, taste)),
        answered,
        taste,
      });
    },
  );

  server.registerTool(
    "generate_playlist",
    {
      title: "Generate a playlist",
      description:
        "Build a playlist from a session, a share code, or a taste profile. Returns the songs, a playlist_id for export_playlist, and a share link. A share code rebuilds the exact shared playlist.",
      inputSchema: {
        session_id: z.string().optional(),
        share_code: z.string().optional().describe("A share code or a whole share link."),
        profile: tasteSchema.optional().describe("A taste vector, as get_profile returns it."),
        length: z.number().int().min(1).max(100).optional(),
        reshuffle: z
          .number()
          .int()
          .min(0)
          .max(1000)
          .optional()
          .describe("Another playlist from the same profile (1, 2, …)."),
        tweaks: z
          .array(tweakSchema)
          .optional()
          .describe("Nudges, applied in order (each axis ±2 at most)."),
        deeper_cuts: z
          .number()
          .int()
          .min(0)
          .max(3)
          .optional()
          .describe(`Append this many pages of ${MORE_LENGTH} deeper cuts.`),
      },
    },
    async (args) => {
      const sources = [args.session_id, args.share_code, args.profile].filter(
        (x) => x !== undefined,
      );
      if (sources.length !== 1)
        return fail("Pass exactly one of session_id, share_code or profile.");
      let catalog: Awaited<ReturnType<CatalogHandle["get"]>>;
      try {
        catalog = await opts.catalog.get();
      } catch (err) {
        return fail((err as Error).message);
      }
      const catalogVersion = catalog.columns.version;
      let data: ShareData;
      const notes: string[] = [];
      const overrides =
        args.length !== undefined || args.reshuffle || (args.tweaks?.length ?? 0) > 0;
      if (args.session_id) {
        const s = sessions.get(args.session_id);
        if (!s) return fail(`No session "${args.session_id}".`);
        const v = viewSession(bank, s);
        if (v.answered === 0) return fail("This session has no answers yet.");
        const salted = { ...s, seed_salt: args.reshuffle ?? s.seed_salt };
        data = {
          taste: tasteVector(bank, v.profile),
          tweaks: {},
          seed: sessionSeed(bank, salted, catalogVersion),
          length: args.length ?? s.config.length,
          answered: v.answered,
          engineVersion: engine,
          catalogVersion,
          ops: [],
        };
      } else if (args.share_code) {
        try {
          data = shareOf(args.share_code);
        } catch {
          return fail("That share code is broken or cut off.");
        }
        if (data.engineVersion !== engine || data.catalogVersion !== catalogVersion)
          notes.push(
            "This link was made with another ABTune version or catalog, so some songs may differ.",
          );
        data = { ...data, engineVersion: engine, catalogVersion };
        if (overrides && data.ops.length) {
          notes.push(
            "The shared playlist's swaps and deeper cuts were dropped because the playlist changed.",
          );
          data = { ...data, ops: [] };
        }
        if (overrides && data.picks) {
          // The AI's picks are positions in the shortlist this taste, seed and length made.
          notes.push("The AI's song picks were dropped because the playlist changed.");
          const { picks: _, ...rest } = data;
          data = rest;
        }
        if (args.length !== undefined) data = { ...data, length: args.length };
        if (args.reshuffle)
          data = {
            ...data,
            seed: sha256Hex(`${data.seed}:reshuffle:${args.reshuffle}`).slice(0, 16),
          };
      } else {
        const taste = args.profile as TasteVector;
        try {
          validateTaste(dims, taste);
        } catch (err) {
          return fail(`Bad profile: ${(err as Error).message}`);
        }
        data = {
          taste,
          tweaks: {},
          seed: sha256Hex(`profile:${JSON.stringify(taste)}:${args.reshuffle ?? 0}`).slice(0, 16),
          length: args.length ?? 25,
          answered: 0,
          engineVersion: engine,
          catalogVersion,
          ops: [],
        };
      }
      let tweaks: TweakSteps = data.tweaks;
      for (const t of args.tweaks ?? []) tweaks = addTweak(tweaks, t);
      const more: ShareOp[] = Array.from({ length: args.deeper_cuts ?? 0 }, () => ({ op: "more" }));
      data = { ...data, tweaks, ops: [...data.ops, ...more] };

      const built = await buildPlaylist(catalog, dims, data);
      if (built.skipped) notes.push("Some of the shared edits could not be repeated.");
      if (built.warnings.includes("catalog_exhausted"))
        notes.push("The catalog ran out of songs that fit, so the playlist is shorter.");
      const engineTitle = playlistTitle(dims, data.taste, data.answered, data.seed);
      const title = { ...engineTitle, title: data.title ?? engineTitle.title };
      const tweakNote = Object.entries(tweaks)
        .map(([axis, n]) => `${axis} ${(n as number) > 0 ? "+" : ""}${n}`)
        .join(", ");
      const description = [
        data.blurb ?? "",
        title.description,
        tweakNote ? `tweaked: ${tweakNote}` : "",
      ]
        .filter(Boolean)
        .join(" · ");
      const id = newId("p");
      playlists.set(id, { id, data, title: title.title, description, tracks: built.tracks });
      const code = encodeShare(dims, data);
      const url = `${base}/#s=${code}`;
      const lines = built.tracks.map(
        (t, i) => `${i + 1}. ${t.title} — ${t.artist}${t.year ? ` (${t.year})` : ""}`,
      );
      return text(
        [
          `playlist_id: ${id}`,
          `"${title.title}": ${built.tracks.length} songs (${catalogVersion})`,
          description,
          ...notes,
          "",
          ...lines,
          "",
          `Share link (opens the card and this exact playlist in the ABTune web app): ${url}`,
          `Export: export_playlist with playlist_id ${id} and format ${EXPORT_FORMATS.join(", ")}.`,
        ].join("\n"),
        {
          playlist_id: id,
          title: title.title,
          description,
          share_code: code,
          share_url: url,
          notes,
          tracks: built.tracks.map((t) => ({
            track_id: t.track_id,
            title: t.title,
            artist: t.artist,
            year: t.year,
          })),
        },
      );
    },
  );

  server.registerTool(
    "export_playlist",
    {
      title: "Export a playlist",
      description:
        "Export a generated playlist as M3U, CSV (for playlist-transfer tools), XSPF or JSON. Writes a file when `path` is given (a file or a folder inside the export folder, with the format's extension); otherwise returns the content. An existing file is replaced only with `overwrite`.",
      inputSchema: {
        playlist_id: z.string(),
        format: z.enum(EXPORT_FORMATS as unknown as [string, ...string[]]),
        path: z.string().optional(),
        overwrite: z.boolean().optional().describe("Replace the file if it exists."),
      },
    },
    async ({ playlist_id, format, path: target, overwrite }) => {
      const p = playlists.get(playlist_id);
      if (!p) return fail(`No playlist "${playlist_id}". Make one with generate_playlist.`);
      const payload: ExportPlaylist = {
        title: p.title,
        description: p.description,
        catalog_version: p.data.catalogVersion,
        engine_version: p.data.engineVersion,
        seed: p.data.seed,
        length: p.tracks.length,
        taste: p.data.taste,
        tweaks: p.data.tweaks,
        tracks: p.tracks.map((t) => ({
          track_id: t.track_id,
          title: t.title,
          artist: t.artist,
          album: t.album,
          year: t.year,
          isrcs: t.isrcs,
          length_ms: t.length_ms,
        })),
      };
      const fmt = format as ExportFormat;
      const file = exportPlaylist(fmt, payload);
      if (!target) return text(file.content, { filename: file.filename, mime: file.mime });
      let out = path.resolve(cwd, target);
      const isDir =
        /[\\/]$/.test(target) ||
        (await stat(out).then(
          (s) => s.isDirectory(),
          () => false,
        ));
      if (isDir) out = path.join(out, file.filename);
      // The host's model picks the path, and a share link's title and blurb reach that model: a
      // file stays in the export folder, keeps its format's extension and replaces nothing unasked.
      if (!inside(cwd, out)) return fail(`Exports are saved inside ${cwd}; ${out} is outside it.`);
      const exts = EXPORT_EXTS[fmt];
      if (!exts.includes(path.extname(out).toLowerCase()))
        return fail(`A ${fmt} export is saved as ${exts.join(" or ")}, not ${path.basename(out)}.`);
      await mkdir(path.dirname(out), { recursive: true });
      // A link inside the folder can still point out of it.
      if (!inside(await realpath(cwd), await realpath(path.dirname(out))))
        return fail(`Exports are saved inside ${cwd}; ${path.dirname(out)} leads outside it.`);
      if (
        await lstat(out).then(
          (s) => s.isSymbolicLink(),
          () => false,
        )
      )
        return fail(`${out} is a link; export to a regular file.`);
      try {
        await writeFile(out, file.content, { encoding: "utf8", flag: overwrite ? "w" : "wx" });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "EEXIST")
          return fail(`${out} already exists. Pass overwrite: true to replace it.`);
        throw err;
      }
      return text(`Wrote ${p.tracks.length} songs to ${out}`, {
        path: out,
        filename: path.basename(out),
      });
    },
  );

  const matchCache = new MatchCache();
  server.registerTool(
    "push_to_spotify",
    {
      title: "Save to Spotify",
      description:
        "Create a generated playlist in the user's Spotify account, private unless `public` is true. Songs Spotify doesn't have are swapped for similar ones (same genre and decade). Needs Spotify set up and connected once in the ABTune web app (its Save to Spotify button).",
      inputSchema: {
        playlist_id: z.string(),
        name: z.string().max(100).optional(),
        public: z.boolean().optional(),
        account: z
          .string()
          .optional()
          .describe("Spotify user id or display name, when several accounts are connected"),
      },
    },
    async ({ playlist_id, name, public: isPublic, account }) => {
      const p = playlists.get(playlist_id);
      if (!p) return fail(`No playlist "${playlist_id}". Make one with generate_playlist.`);
      const webApp = `the ABTune web app (${base})`;
      const settings = opts.spotify;
      const missing = settings ? missingSettings(settings) : ["SPOTIFY_CLIENT_ID"];
      if (!settings || missing.length > 0)
        return fail(
          `Spotify isn't set up (${missing.join(", ")} missing in .env). Open ${webApp}, press "Save to Spotify" and follow the setup, then connect once; this server reads the same .env. Meanwhile, export_playlist (CSV) imports into playlist-transfer tools.`,
        );
      const store = new TokenStore(settings.tokenFile, settings.secret);
      let all: { entry: string; connection: Connection }[];
      try {
        all = await store.all();
      } catch (err) {
        return fail(
          `Can't read the Spotify connections (${store.file}): ${(err as Error).message}`,
        );
      }
      const label = (c: Connection) => c.display_name ?? c.user_id;
      const want = account?.trim().toLowerCase();
      const pick = want
        ? all.filter(
            (e) =>
              e.connection.user_id.toLowerCase() === want ||
              e.connection.display_name?.toLowerCase() === want,
          )
        : all;
      const chosen = pick[0];
      if (!chosen)
        return fail(
          want
            ? `No connected Spotify account "${account}". Connected: ${all.map((e) => label(e.connection)).join(", ") || "none"}.`
            : `No Spotify account is connected. Open ${webApp}, press "Save to Spotify" and connect once, then try again.`,
        );
      if (new Set(pick.map((e) => e.connection.user_id)).size > 1)
        return fail(
          `Several Spotify accounts are connected: ${pick.map((e) => `${label(e.connection)} (${e.connection.user_id})`).join(", ")}. Say which one with "account".`,
        );
      const conn = chosen.connection;
      let catalog: Awaited<ReturnType<CatalogHandle["get"]>>;
      try {
        catalog = await opts.catalog.get();
      } catch (err) {
        return fail((err as Error).message);
      }
      const cfg = spotifyConfig(settings);
      try {
        const report = await pushPlaylist(
          new SpotifyClient(cfg, new StoredTokens(cfg, store, chosen.entry, conn)),
          {
            name: name ?? p.title,
            description: playlistDescription(p.description),
            public: isPublic ?? false,
            songs: p.tracks.map((t) => ({
              track_id: t.track_id,
              title: t.title,
              artist: t.artist,
              isrcs: t.isrcs,
            })),
            backfill: catalogBackfill(
              catalog,
              firstStep(
                dims,
                playlistBase(dims, p.data.taste, p.data.adjust),
                p.data.tweaks,
                p.data.seed,
                p.data.length,
              ),
            ),
            cache: matchCache,
            account: conn.user_id,
          },
        );
        const lines = [
          `Saved "${report.playlist.name}" to ${label(conn)}'s Spotify (${isPublic ? "public" : "private"}): ${report.added} of ${report.requested} songs.`,
          `${report.matched} found as is (${report.byIsrc} by ISRC), ${report.replaced.length} swapped for similar songs${report.missing.length ? `, ${report.missing.length} missing` : ""}.`,
          ...report.replaced.map(
            (r) =>
              `  ${r.position + 1}. ${r.missing.title} — ${r.missing.artist} → ${r.replacement.title} — ${r.replacement.artist}`,
          ),
          `Open: ${report.playlist.url}`,
        ];
        return text(lines.join("\n"), {
          playlist_url: report.playlist.url,
          name: report.playlist.name,
          account: conn.user_id,
          requested: report.requested,
          added: report.added,
          matched: report.matched,
          replaced: report.replaced.length,
          missing: report.missing.length,
        });
      } catch (err) {
        if (!isSpotifyError(err)) throw err;
        const why: Partial<Record<typeof err.kind, string>> = {
          not_connected: `Spotify needs the user to connect again: open ${webApp} and press "Save to Spotify".`,
          unauthorized: `Spotify didn't accept the sign-in: open ${webApp} and connect again.`,
          forbidden:
            "Spotify refused: this account may not be on the Spotify app's User Management list, or the app owner's Premium has lapsed.",
          quota_exceeded:
            "This Spotify app's request quota is used up for now. Try later, or use export_playlist (CSV).",
          rate_limited: `Spotify asked to slow down${err.retryAfter ? ` (try again in ${err.retryAfter} s)` : ""}.`,
          no_matches: "None of these songs are on Spotify.",
        };
        const partial = err.partial
          ? ` The playlist was created but not filled completely: ${err.partial.url}`
          : "";
        return fail(`${why[err.kind] ?? `Spotify failed: ${err.message}`}${partial}`);
      }
    },
  );

  return server;
}
