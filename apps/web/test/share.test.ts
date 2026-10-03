// Share links (HANDOFF §4.4, M6): a link rebuilds the exact playlist, edits included (§16 #2 "the
// same holds for share links"), and carries no answers (§13, §16 #9).
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import type { CatalogManifest } from "@abtune/catalog";
import { loadCatalog } from "@abtune/catalog/reader";
import {
  type Bank,
  type Choice,
  createSession,
  decodeShare,
  encodeShare,
  engineVersion,
  reduceSession,
  type SessionState,
  type ShareData,
  type ShareOp,
  type TweakSteps,
  tasteVector,
  viewSession,
} from "@abtune/engine";
import { afterAll, describe, expect, it } from "vitest";
import type { PlaylistRequest, PlaylistResponse, PlaylistTrackOut } from "../src/api-types.ts";
import { type ApiResult, buildPlaylistRequest } from "../src/client/state/api.ts";
import {
  applyEdit,
  editRequest,
  replayShare,
  shareCodeOf,
  shareUrl,
} from "../src/client/state/share.ts";
import { createApp } from "../src/server/app.ts";
import { catalogInfo, catalogSlot } from "../src/server/catalog.ts";

const repo = (p: string) => fileURLToPath(new URL(`../../../${p}`, import.meta.url));

describe("share links", async () => {
  const result = await loadBankFromDisk(["*.yaml"], { cwd: repo("data/questions") });
  if (!result.bank) throw new Error("bank failed to load");
  const bank: Bank = result.bank;
  const dir = repo("data/catalog-fixture");
  const manifest = JSON.parse(await readFile(`${dir}/manifest.json`, "utf8")) as CatalogManifest;
  const loaded = await loadCatalog(dir, bank.dimensions, { threads: 2 });
  afterAll(() => loaded.close());
  const info = catalogInfo(manifest);
  const slot = catalogSlot(info, Promise.resolve(loaded));
  await slot.settled;
  const app = createApp({ bank, version: "9.9.9", catalog: slot });

  let posts = 0;
  const post = async (req: PlaylistRequest): Promise<ApiResult<PlaylistResponse>> => {
    posts++;
    const res = await app.request("/api/playlist", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(req),
    });
    const body = await res.json();
    return res.ok
      ? { ok: true, data: body as PlaylistResponse }
      : { ok: false, status: res.status, error: body };
  };

  /** A seeded 20-answer session with spicy questions on (sensitive answers in the log). */
  function session(choices: readonly Choice[]): SessionState {
    let s = createSession(bank, {
      mode: 20,
      length: 25,
      packs: ["context", "core", "deep", "spicy", "vibe"],
      quiz_seed: "a1b2c3d4e5f60718",
    });
    let i = 0;
    while (viewSession(bank, s).status === "asking")
      s = reduceSession(bank, s, {
        type: "answer",
        choice: choices[i++ % choices.length] as Choice,
      });
    return s;
  }

  /** What the result screen does: the first playlist, then each edit on what's shown. */
  async function live(s: SessionState, tweaks: TweakSteps, ops: readonly ShareOp[]) {
    const first = buildPlaylistRequest(bank, s, tweaks, info.version);
    const r = await post(first);
    if (!r.ok) throw new Error("first playlist failed");
    let shown: PlaylistTrackOut[] = [...r.data.tracks];
    const base = tasteVector(bank, viewSession(bank, s).profile);
    const done: ShareOp[] = [];
    for (const op of ops) {
      const e = await post(editRequest(bank.dimensions, base, tweaks, first, shown, done, op));
      if (!e.ok) throw new Error("edit failed");
      shown = applyEdit(shown, op, e.data.tracks);
      done.push(op);
    }
    const data: ShareData = {
      taste: base,
      tweaks,
      seed: r.data.seed,
      length: r.data.length,
      answered: viewSession(bank, s).answered,
      engineVersion: r.data.engine_version,
      catalogVersion: r.data.catalog_version,
      ops: done,
    };
    return { shown, data };
  }

  const versions = { engine_version: engineVersion(bank), catalog_version: info.version };
  const ids = (ts: readonly PlaylistTrackOut[]) => ts.map((x) => x.track_id);

  it.each([
    ["plain", {}, []],
    ["tweaked", { energy: 2, era: -1 }, []],
    [
      "deeper cuts and swaps",
      { popularity: 1 },
      [{ op: "more" }, { op: "swap", index: 3 }, { op: "more" }, { op: "swap", index: 40 }],
    ],
  ] as [string, TweakSteps, ShareOp[]][])(
    "rebuilds the exact list on another device: %s",
    async (_, tweaks, ops) => {
      const s = session(["a", "b", "both", "a", "skip"]);
      const { shown, data } = await live(s, tweaks, ops);
      const code = encodeShare(bank.dimensions, data);
      expect(code.length).toBeLessThan(300);
      // A fresh device has only the link.
      const url = shareUrl("https://abtune.example/?x=1#old", code);
      const back = decodeShare(bank.dimensions, shareCodeOf(new URL(url).hash) ?? "");
      expect(back).toEqual(data);
      const replay = await replayShare(bank.dimensions, back, versions, post);
      expect(replay.ok).toBe(true);
      if (!replay.ok) return;
      expect(replay.skipped).toBe(0);
      expect(ids(replay.tracks)).toEqual(ids(shown));
      expect(shown.length).toBe(25 + 25 * ops.filter((o) => o.op === "more").length);
    },
  );

  it("carries no answers: sensitive ones stay on the device (HANDOFF §13, §16 #9)", async () => {
    const s = session(["a", "b", "both", "a"]);
    const sensitive = s.answer_log.filter(
      (e) => bank.questions.find((q) => q.id === e.id)?.sensitive,
    );
    expect(sensitive.length).toBeGreaterThan(0);
    const { data } = await live(s, {}, []);
    const decoded = decodeShare(bank.dimensions, encodeShare(bank.dimensions, data));
    expect(Object.keys(decoded).sort()).toEqual([
      "answered",
      "catalogVersion",
      "engineVersion",
      "length",
      "ops",
      "seed",
      "taste",
      "tweaks",
    ]);
    const text = JSON.stringify(decoded);
    for (const q of bank.questions) {
      expect(text).not.toContain(q.id);
      expect(text).not.toContain(q.a.label);
    }
  });

  it("still makes a playlist when the server runs another catalog or engine", async () => {
    const s = session(["b", "a"]);
    const { data } = await live(s, {}, [{ op: "more" }]);
    const old = {
      ...data,
      engineVersion: "0.1.0+bank.deadbeef",
      catalogVersion: "catalog-1999.01",
    };
    const before = posts;
    const replay = await replayShare(bank.dimensions, old, versions, post);
    expect(replay.ok).toBe(true);
    if (replay.ok) expect(replay.tracks.length).toBe(50);
    expect(posts - before).toBe(2);
  });

  it("finds the code in a location hash", () => {
    expect(shareCodeOf("#s=AbC-_1")).toBe("AbC-_1");
    expect(shareCodeOf("#s=")).toBeNull();
    expect(shareCodeOf("#other")).toBeNull();
    expect(shareCodeOf("")).toBeNull();
    expect(shareUrl("http://127.0.0.1:8787/#s=old", "new")).toBe("http://127.0.0.1:8787/#s=new");
  });
});
