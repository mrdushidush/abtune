import { createHash } from "node:crypto";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { downloadFile, localPath } from "../src/download.ts";
import {
  type LockedFile,
  listingEntries,
  parseChecksums,
  resolveCanonical,
  resolveListenBrainzStats,
  resolveMusicBrainz,
} from "../src/sources.ts";

const payload = Buffer.from(Array.from({ length: 300_000 }, (_, i) => i % 251));
const sha = createHash("sha256").update(payload).digest("hex");

let server: Server;
let base = "";
/** Requests seen, and a switch that makes the next full response die halfway. */
const seen: { range?: string }[] = [];
let cutNext = false;

beforeAll(async () => {
  server = createServer((req, res) => {
    seen.push({ range: req.headers.range });
    const m = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const start = m ? Number(m[1]) : 0;
    if (start >= payload.length) {
      res.writeHead(416).end();
      return;
    }
    res.writeHead(m ? 206 : 200, { "content-length": payload.length - start });
    if (cutNext) {
      cutNext = false;
      res.write(payload.subarray(start, start + 100_000));
      // Let the first bytes reach the client before the connection drops.
      setTimeout(() => res.destroy(), 100);
      return;
    }
    res.end(payload.subarray(start));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

const file = (sha256 = sha): LockedFile => ({
  source: "canonical",
  path: "canonical/x.tar.zst",
  url: `${base}/x`,
  sha256,
  dumpDate: "2026-09-17",
});

describe("downloadFile", () => {
  it("downloads, verifies and then reports the file as present", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "abtune-dl-"));
    expect(await downloadFile(file(), { dir })).toBe("downloaded");
    expect(await readFile(localPath(dir, file()))).toEqual(payload);
    expect(await downloadFile(file(), { dir })).toBe("present");
  });

  it("resumes with a Range request after an interrupted transfer", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "abtune-dl-"));
    seen.length = 0;
    cutNext = true;
    expect(await downloadFile(file(), { dir, retryDelayMs: 1 })).toBe("downloaded");
    expect(await readFile(localPath(dir, file()))).toEqual(payload);
    expect(seen[0]?.range).toBeUndefined();
    expect(seen.at(-1)?.range).toMatch(/^bytes=\d+-$/);
  });

  it("fails after retries on a checksum mismatch", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "abtune-dl-"));
    await expect(
      downloadFile(file("0".repeat(64)), { dir, retries: 1, retryDelayMs: 1 }),
    ).rejects.toThrow(/sha256 mismatch/);
  });

  it("re-downloads a present file whose checksum is wrong", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "abtune-dl-"));
    const target = localPath(dir, file());
    await downloadFile(file(), { dir });
    await writeFile(target, "corrupt");
    await writeFile(`${target}.verified`, "stale\n");
    expect(await downloadFile(file(), { dir })).toBe("downloaded");
    expect(await readFile(target)).toEqual(payload);
  });
});

describe("source resolution", () => {
  const H = "a".repeat(64);
  const pages: Record<string, string> = {
    "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/LATEST": "20260930-002222\n",
    "https://data.metabrainz.org/pub/musicbrainz/data/fullexport/20260930-002222/SHA256SUMS": `${H} *mbdump.tar.bz2\n${"b".repeat(64)} *mbdump-derived.tar.bz2\n`,
    "https://data.metabrainz.org/pub/musicbrainz/canonical_data/":
      '<a href="../">../</a><a href="musicbrainz-canonical-dump-20260903-080002/">x</a><a href="musicbrainz-canonical-dump-20260917-080002/">y</a>',
    "https://data.metabrainz.org/pub/musicbrainz/canonical_data/musicbrainz-canonical-dump-20260917-080002/musicbrainz-canonical-dump-20260917-080002.tar.zst.sha256":
      H,
    "https://data.metabrainz.org/pub/musicbrainz/listenbrainz/fullexport/":
      '<a href="listenbrainz-dump-2647-20260901-000002-full/">a</a><a href="listenbrainz-dump-2679-20261001-000002-full/">b</a>',
    // The newest export is still uploading: no statistics checksum yet.
    "https://data.metabrainz.org/pub/musicbrainz/listenbrainz/fullexport/listenbrainz-dump-2679-20261001-000002-full/":
      '<a href="listenbrainz-statistics-dump-20261001-000002.tar.zst">s</a>',
    "https://data.metabrainz.org/pub/musicbrainz/listenbrainz/fullexport/listenbrainz-dump-2647-20260901-000002-full/":
      '<a href="listenbrainz-statistics-dump-20260901-000002.tar.zst">s</a><a href="listenbrainz-statistics-dump-20260901-000002.tar.zst.sha256">c</a>',
    "https://data.metabrainz.org/pub/musicbrainz/listenbrainz/fullexport/listenbrainz-dump-2647-20260901-000002-full/listenbrainz-statistics-dump-20260901-000002.tar.zst.sha256": `${H}  listenbrainz-statistics-dump-20260901-000002.tar.zst\n`,
  };
  const get = async (url: string) => {
    const page = pages[url];
    if (page === undefined) throw new Error(`unexpected ${url}`);
    return page;
  };

  it("pins MusicBrainz LATEST with SHA256SUMS", async () => {
    const files = await resolveMusicBrainz(get);
    expect(files.map((f) => [f.source, f.path, f.dumpDate])).toEqual([
      ["mb-core", "musicbrainz/20260930-002222/mbdump.tar.bz2", "2026-09-30"],
      ["mb-derived", "musicbrainz/20260930-002222/mbdump-derived.tar.bz2", "2026-09-30"],
    ]);
  });

  it("picks the newest canonical dump", async () => {
    const [f] = await resolveCanonical(get);
    expect(f?.path).toBe("canonical/musicbrainz-canonical-dump-20260917-080002.tar.zst");
    expect(f?.sha256).toBe(H);
  });

  it("skips ListenBrainz exports that are still uploading", async () => {
    const [f] = await resolveListenBrainzStats(get);
    expect(f?.path).toBe("listenbrainz/listenbrainz-statistics-dump-20260901-000002.tar.zst");
    expect(f?.dumpDate).toBe("2026-09-01");
  });

  it("parses listings and checksum files", () => {
    expect(
      listingEntries('<a href="../">..</a><a href="a%20b/">a b/</a><a href="?C=M">sort</a>'),
    ).toEqual(["a b/"]);
    expect(parseChecksums(`${H}  one.tar.zst\n${H} *two.bz2\nnoise\n`)).toEqual(
      new Map([
        ["one.tar.zst", H],
        ["two.bz2", H],
      ]),
    );
  });
});
