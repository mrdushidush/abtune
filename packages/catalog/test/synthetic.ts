// A tiny but complete set of source dumps for end-to-end pipeline tests: same formats as the real
// MetaBrainz files (headerless Postgres TSV in .tar.bz2, CSV/JSONL/JSON in .tar.zst).
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { AB_CLASSIFIERS } from "../src/extract/ab.ts";
import { MB_TABLES } from "../src/mb-schema.ts";
import type { LockedFile, SourcesLock } from "../src/sources.ts";
import { writeTar } from "../src/tar.ts";

const CC0 = "Creative Commons Legal Code\n\nCC0 1.0 Universal\n";
const NCSA = "              Attribution-NonCommercial-ShareAlike 3.0 US\n";

/** Deterministic UUIDs: one namespace digit per entity kind. */
export const uuid = (kind: number, n: number) =>
  `${kind}0000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;

type Cell = string | number | null;
const pgText = (v: Cell) =>
  v === null
    ? "\\N"
    : String(v).replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll("\n", "\\n");
const tsv = (rows: Cell[][]) =>
  rows.map((r) => r.map(pgText).join("\t")).join("\n") + (rows.length ? "\n" : "");

/** Small seeded PRNG for filler data (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Recording {
  id: number;
  artist: number;
  title: string;
  comment?: string;
  lengthMs?: number | null;
  year?: number;
  release: number;
  canonicalOf?: number;
  isrc?: string;
  work?: number;
  /** User ids that have this recording in their top list. */
  users?: number[];
  ab?: { energy: number; happy: number } | null;
  tags?: [string, number][];
  bpm?: number;
}

/** Hand-built scenarios plus seeded filler so the ridge model has data. */
export function scenario() {
  const artists = [
    { id: 1, name: "Bon Jovi", area: 3 },
    { id: 2, name: "Omer Adam", area: 2 }, // Tel Aviv → Israel
    { id: 3, name: "Various Artists", area: null },
    { id: 4, name: "Arik Einstein", area: 1 },
    { id: 5, name: "New Artist", area: 3 },
    { id: 6, name: "A Comedian", area: 3 },
    { id: 7, name: "Static & Ben El", area: 2 },
    { id: 8, name: "Hebrew Singer", area: null },
  ];
  const releases = [
    { id: 1, rg: 1, name: "Slippery When Wet", lang: "eng" },
    { id: 2, rg: 2, name: "Greatest Hits (Remastered)", lang: "eng" },
    { id: 3, rg: 3, name: "Live in Tokyo", lang: "eng" },
    { id: 4, rg: 4, name: "Omer", lang: "heb" },
    { id: 5, rg: 5, name: "Arik", lang: "heb" },
    { id: 6, rg: 6, name: "Fresh", lang: "eng" },
    { id: 7, rg: 7, name: "Compilation", lang: "eng" },
    { id: 8, rg: 8, name: "Stand-up Night", lang: "eng" },
    { id: 9, rg: 9, name: "Bli Safa", lang: "und" }, // no language recorded
  ];
  const range = (a: number, b: number) => Array.from({ length: b - a + 1 }, (_, i) => a + i);
  const recordings: Recording[] = [
    {
      id: 1,
      artist: 1,
      title: "Livin' on a Prayer",
      year: 1986,
      release: 1,
      users: range(1, 40),
      ab: { energy: 0.9, happy: 0.8 },
      tags: [["hard rock", 5]],
      isrc: "USPR38600001",
      bpm: 123,
    },
    {
      id: 2,
      artist: 1,
      title: "Livin' on a Prayer - 2011 Remaster",
      year: 2011,
      release: 2,
      users: range(30, 45),
      ab: null,
      isrc: "USPR31100001",
    },
    {
      id: 3,
      artist: 1,
      title: "Livin' on a Prayer (Live)",
      year: 1995,
      release: 3,
      users: range(1, 25),
      ab: { energy: 0.95, happy: 0.7 },
      tags: [["rock", 2]],
    },
    {
      id: 4,
      artist: 1,
      title: "Bed of Roses",
      year: 1992,
      release: 1,
      users: range(1, 20),
      ab: null,
      tags: [["soft rock", 3]],
    },
    {
      id: 5,
      artist: 1,
      title: "Bed of Roses",
      year: 1992,
      release: 2,
      canonicalOf: 4,
      users: [],
      ab: { energy: 0.3, happy: 0.4 },
    },
    {
      id: 6,
      artist: 2,
      title: "Shir",
      year: 2019,
      release: 4,
      users: range(1, 3),
      ab: null,
      work: 1,
    },
    {
      id: 7,
      artist: 2,
      title: "Shir (Acoustic)",
      year: 2019,
      release: 4,
      users: [],
      ab: { energy: 0.2, happy: 0.3 },
      work: 1,
    },
    {
      id: 8,
      artist: 4,
      title: "Ani Ve'Ata",
      year: 1971,
      release: 5,
      users: range(1, 2),
      ab: { energy: 0.3, happy: 0.6 },
    },
    {
      id: 9,
      artist: 5,
      title: "Fresh 2024",
      year: 2024,
      release: 6,
      users: range(1, 45),
      ab: null,
      tags: [["synth-pop", 2]],
    },
    { id: 10, artist: 3, title: "Medley", year: 2000, release: 7, users: range(1, 50), ab: null },
    {
      id: 11,
      artist: 6,
      title: "Airport Bit",
      year: 2015,
      release: 8,
      users: range(1, 50),
      ab: null,
      tags: [["comedy", 4]],
    },
    {
      id: 12,
      artist: 1,
      title: "Karaoke Version of Always",
      year: 2005,
      release: 7,
      users: range(1, 50),
      ab: null,
    },
    {
      id: 13,
      artist: 1,
      title: "Intro",
      year: 1986,
      release: 1,
      lengthMs: 20_000,
      users: range(1, 50),
      ab: null,
    },
    // Hebrew-script title, no work or release language, artist without an area.
    { id: 14, artist: 8, title: "שיר ערש", year: 2010, release: 9, users: range(1, 35), ab: null },
    // An IL artist's song in nobody's top list: only the popularity API can rank it.
    { id: 15, artist: 7, title: "תודה", year: 2021, release: 9, users: [], ab: null },
  ];
  // Filler: 20 artists × 12 songs with AcousticBrainz data and genre tags.
  const random = rng(42);
  const genres = ["pop", "rock", "hip hop", "jazz", "house", "folk", "metal", "soul"];
  for (let a = 0; a < 20; a++) {
    const artist = 100 + a;
    artists.push({ id: artist, name: `Filler ${a}`, area: 3 });
    releases.push({ id: 100 + a, rg: 100 + a, name: `Filler Album ${a}`, lang: "eng" });
    const genre = genres[a % genres.length] ?? "pop";
    const base = random();
    for (let s = 0; s < 12; s++) {
      const id = 1000 + a * 100 + s;
      const users = range(1, 1 + Math.floor(random() * 30));
      recordings.push({
        id,
        artist,
        title: `Filler Song ${a}-${s}`,
        year: 1960 + Math.floor(random() * 62),
        release: 100 + a,
        users,
        // Some filler lacks AB data, so the model has targets; artist means carry signal.
        ab:
          s % 4 === 3
            ? null
            : { energy: Math.min(1, base * 0.8 + random() * 0.2), happy: random() },
        tags: [[genre, 1 + (s % 3)]],
        bpm: 70 + Math.floor(random() * 100),
      });
    }
  }
  return { artists, releases, recordings };
}

async function sha256(file: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

function systemTar(): string {
  return process.platform === "win32"
    ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    : "tar";
}

function abDoc(ab: { energy: number; happy: number }) {
  const p = (x: number) => Math.max(0, Math.min(1, x));
  const value: Record<string, number> = {
    danceable: p(ab.energy * 0.9),
    happy: p(ab.happy),
    sad: p(1 - ab.happy),
    relaxed: p(1 - ab.energy),
    party: p(ab.energy * ab.happy),
    aggressive: p(ab.energy * 0.6),
    acoustic: p(1 - ab.energy),
    electronic: p(ab.energy * 0.5),
    voice: 0.8,
  };
  const highlevel: Record<string, { all: Record<string, number> }> = {};
  for (const [classifier, classes] of Object.entries(AB_CLASSIFIERS)) {
    const all: Record<string, number> = {};
    for (const k of classes as readonly string[]) all[k] = value[k] ?? 1 / classes.length;
    highlevel[classifier] = { all };
  }
  return { highlevel, metadata: {} };
}

/** Write the dumps and sources.lock.json into a fresh temp dir; returns its dumps directory. */
export async function writeSyntheticDumps(): Promise<{
  root: string;
  dumps: string;
  lock: SourcesLock;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "abtune-synth-"));
  const dumps = path.join(root, "dumps");
  const { artists, releases, recordings } = scenario();
  const files: LockedFile[] = [];
  const add = async (source: LockedFile["source"], rel: string) => {
    files.push({
      source,
      path: rel,
      url: `file:///${rel}`,
      sha256: await sha256(path.join(dumps, rel)),
      dumpDate: "2026-09-30",
    });
  };

  // ── MusicBrainz core + derived (.tar.bz2 via system tar) ──
  const recRows: Cell[][] = recordings.map((r) => [
    r.id,
    uuid(1, r.id),
    r.title,
    r.artist,
    r.lengthMs === undefined ? 240_000 : r.lengthMs,
    r.comment ?? "",
    0,
    null,
    "f",
  ]);
  const tagNames = [...new Set(recordings.flatMap((r) => (r.tags ?? []).map(([t]) => t)))].sort();
  const tagId = (t: string) => tagNames.indexOf(t) + 1;
  const langs: [number, string][] = [
    [120, "eng"],
    [200, "heb"],
    [486, "zxx"],
  ];
  const tables: Record<string, Cell[][]> = {
    recording: recRows,
    recording_gid_redirect: [[uuid(9, 2), 2, null]], // an old MBID merged into recording 2
    // Years come from release events: each recording also sits on a dated single (release 10000 + id).
    track: recordings.map((r) => [
      r.id,
      uuid(9, 1000 + r.id),
      r.id,
      10_000 + r.id,
      1,
      "1",
      r.title,
      r.artist,
      null,
      0,
      null,
      "f",
    ]),
    medium: recordings.map((r) => [
      10_000 + r.id,
      10_000 + r.id,
      1,
      null,
      "",
      0,
      null,
      1,
      uuid(9, 5000 + r.id),
    ]),
    release_country: recordings
      .filter((r) => r.year && r.id % 2 === 0)
      .map((r) => [10_000 + r.id, 3, r.year ?? null, 1, 1]),
    release_unknown_country: recordings
      .filter((r) => r.year && r.id % 2 === 1)
      .map((r) => [10_000 + r.id, r.year ?? null, null, null]),
    release: releases.map((r) => [
      r.id,
      uuid(2, r.id),
      r.name,
      1,
      r.rg,
      1,
      null,
      langs.find(([, c]) => c === r.lang)?.[0] ?? null,
      null,
      null,
      "",
      0,
      -1,
      null,
    ]),
    release_group: releases.map((r) => [r.rg, uuid(3, r.rg), r.name, 1, 1, "", 0, null]),
    release_group_secondary_type: [
      [1, "Compilation", null, 0, null, uuid(8, 1)],
      [2, "Spokenword", null, 0, null, uuid(8, 2)],
    ],
    release_group_secondary_type_join: [
      [7, 1, null],
      [8, 2, null],
    ],
    artist: artists.map((a) => [
      a.id,
      uuid(4, a.id),
      a.name,
      a.name,
      null,
      null,
      null,
      null,
      null,
      null,
      1,
      a.area,
      null,
      "",
      0,
      null,
      "f",
      null,
      null,
    ]),
    artist_credit: artists.map((a) => [a.id, a.name, 1, 1, null, 0, uuid(5, a.id)]),
    artist_credit_name: artists.map((a) => [a.id, 0, a.id, a.name, ""]),
    area: [
      [1, uuid(6, 1), "Israel", 1, 0, null, null, null, null, null, null, null, "f", ""],
      [2, uuid(6, 2), "Tel Aviv", 3, 0, null, null, null, null, null, null, null, "f", ""],
      [3, uuid(6, 3), "United States", 1, 0, null, null, null, null, null, null, null, "f", ""],
    ],
    iso_3166_1: [
      [1, "IL"],
      [3, "US"],
    ],
    l_area_area: [[1, 20, 1, 2, 0, null, 0, "", ""]],
    l_recording_work: recordings
      .filter((r) => r.work)
      .map((r, i) => [i + 1, 10, r.id, r.work ?? 0, 0, null, 0, "", ""]),
    link: [
      [10, 1, null, null, null, null, null, null, 0, null, "f"],
      [20, 2, null, null, null, null, null, null, 0, null, "f"],
    ],
    link_type: [
      [
        1,
        null,
        0,
        uuid(7, 1),
        "recording",
        "work",
        "performance",
        "",
        "",
        "",
        "",
        null,
        "f",
        "t",
        0,
        0,
      ],
      [2, null, 0, uuid(7, 2), "area", "area", "part of", "", "", "", "", null, "f", "t", 0, 0],
    ],
    work_language: [[1, 200, 0, null]],
    language: langs.map(([id, code]) => [id, code, code, null, code, 1, code]),
    isrc: recordings.filter((r) => r.isrc).map((r, i) => [i + 1, r.id, r.isrc ?? "", 0, null]),
    tag: tagNames.map((t, i) => [i + 1, t, 1]),
    recording_tag: recordings.flatMap((r) =>
      (r.tags ?? []).map(([t, n]) => [r.id, tagId(t), n, null] as Cell[]),
    ),
    release_group_tag: [],
    artist_tag: [[6, tagId("comedy"), 3, null]],
  };
  for (const dump of ["core", "derived"] as const) {
    const dir = path.join(root, `mb-${dump}`);
    await mkdir(path.join(dir, "mbdump"), { recursive: true });
    await writeFile(path.join(dir, "COPYING"), dump === "core" ? CC0 : NCSA);
    await writeFile(path.join(dir, "SCHEMA_SEQUENCE"), "31\n");
    for (const t of MB_TABLES.filter((x) => x.dump === dump)) {
      const rows = tables[t.name] ?? [];
      for (const r of rows)
        if (r.length !== t.columns.length)
          throw new Error(`synthetic ${t.name}: ${r.length} cells`);
      await writeFile(path.join(dir, "mbdump", t.name), tsv(rows));
    }
    const rel = `musicbrainz/20260930-002222/${dump === "core" ? "mbdump" : "mbdump-derived"}.tar.bz2`;
    await mkdir(path.dirname(path.join(dumps, rel)), { recursive: true });
    const r = spawnSync(
      systemTar(),
      ["-cjf", path.join(dumps, rel), "-C", dir, "COPYING", "SCHEMA_SEQUENCE", "mbdump"],
      { encoding: "utf8" },
    );
    if (r.status !== 0) throw new Error(`tar -cjf failed: ${r.stderr}`);
    await add(dump === "core" ? "mb-core" : "mb-derived", rel);
  }

  const zst = async (
    source: LockedFile["source"],
    rel: string,
    entries: { name: string; data: string | Buffer }[],
  ) => {
    const file = path.join(dumps, rel);
    await mkdir(path.dirname(file), { recursive: true });
    const tar = Buffer.concat([
      ...writeTar(entries.map((e) => ({ name: e.name, data: Buffer.from(e.data) }))),
    ]);
    await writeFile(file, zstdCompressSync(tar));
    await add(source, rel);
  };

  // ── Canonical redirects ──
  const cdir = "musicbrainz-canonical-dump-20260917-080002";
  await zst("canonical", `canonical/${cdir}.tar.zst`, [
    { name: `${cdir}/COPYING`, data: CC0 },
    { name: `${cdir}/canonical/canonical_musicbrainz_data.csv`, data: "id,unused\n" },
    {
      name: `${cdir}/canonical/canonical_recording_redirect.csv`,
      data: `recording_mbid,canonical_recording_mbid,canonical_release_mbid\n${recordings
        .map(
          (r) =>
            `${uuid(1, r.id)},${uuid(1, r.canonicalOf ?? r.id)},${uuid(2, recordings.find((x) => x.id === (r.canonicalOf ?? r.id))?.release ?? r.release)}`,
        )
        .join("\n")}\n`,
    },
    {
      name: `${cdir}/canonical/canonical_release_redirect.csv`,
      data: "release_mbid,canonical_release_mbid,release_group_mbid\n",
    },
  ]);

  // ── ListenBrainz statistics: per-user top recordings (recording 2 also listened via its old MBID) ──
  const users = new Map<number, { recording_mbid: string; listen_count: number }[]>();
  for (const r of recordings) {
    for (const u of r.users ?? []) {
      const list = users.get(u) ?? [];
      list.push({
        recording_mbid: r.id === 2 && u % 2 ? uuid(9, 2) : uuid(1, r.id),
        listen_count: 1 + ((u * 7 + r.id) % 13),
      });
      users.set(u, list);
    }
  }
  const jsonl = [...users.entries()]
    .sort(([a], [b]) => a - b)
    .map(([u, data]) =>
      JSON.stringify({ user_id: u, data: [...data, { recording_mbid: null, listen_count: 3 }] }),
    );
  const ldir = "listenbrainz-statistics-dump-20260915-000002";
  await zst("lb-stats", `listenbrainz/${ldir}.tar.zst`, [
    { name: `${ldir}/COPYING`, data: CC0 },
    { name: `${ldir}/lbdump/statistics/artists_all_time.jsonl`, data: "{}\n" },
    { name: `${ldir}/lbdump/statistics/recordings_all_time.jsonl`, data: `${jsonl.join("\n")}\n` },
  ]);

  // ── AcousticBrainz high-level (2 parts) and rhythm ──
  const withAb = recordings.filter((r) => r.ab);
  const parts = [withAb.filter((_, i) => i % 2 === 0), withAb.filter((_, i) => i % 2 === 1)];
  for (const [i, part] of parts.entries()) {
    const entries = part.map((r) => {
      const g = uuid(1, r.id);
      return {
        name: `acousticbrainz-highlevel-json-20220623/highlevel/${g.slice(0, 2)}/${g[2]}/${g}-0.json`,
        data: JSON.stringify(abDoc(r.ab ?? { energy: 0, happy: 0 })),
      };
    });
    await zst(
      "ab-highlevel",
      `acousticbrainz/acousticbrainz-highlevel-json-20220623-${i}.tar.zst`,
      entries,
    );
  }
  const rhythm = [
    "mbid,submission_offset,bpm,bpm_histogram_first_peak_bpm_mean,bpm_histogram_first_peak_bpm_median,bpm_histogram_second_peak_bpm_mean,bpm_histogram_second_peak_bpm_median,danceability,onset_rate",
  ]
    .concat(withAb.map((r) => `${uuid(1, r.id)},0,${r.bpm ?? 120},0,0,0,0,1,2`))
    .join("\n");
  await zst(
    "ab-rhythm",
    "acousticbrainz/acousticbrainz-lowlevel-features-20220623-rhythm.tar.zst",
    [
      {
        name: "acousticbrainz-lowlevel-features-20220623/acousticbrainz-lowlevel-features-20220623-rhythm.csv",
        data: `${rhythm}\n`,
      },
    ],
  );

  const lock: SourcesLock = { version: 1, resolvedAt: "2026-10-01T00:00:00.000Z", files };
  await writeFile(path.join(dumps, "sources.lock.json"), `${JSON.stringify(lock, null, 2)}\n`);
  return { root, dumps, lock };
}
