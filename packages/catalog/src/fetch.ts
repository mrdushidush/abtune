// `abtune catalog fetch`: download (or take a local copy of) the prebuilt dev sample, verify it,
// and unpack it under data/catalog/. No DuckDB or system tar needed (HANDOFF §16 #1).

import { once } from "node:events";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { sha256File } from "./files.ts";
import type { CatalogManifest } from "./manifest.ts";
import { USER_AGENT } from "./sources.ts";
import { readTar } from "./tar.ts";

/** Where `fetch` looks by default; overridable with CATALOG_SAMPLE_URL. Public once the repo is (v0.1). */
export const DEFAULT_SAMPLE_URL =
  "https://github.com/mrdushidush/abtune/releases/download/catalog-2026.09.2/catalog-2026.09.2-dev50k.tar";

export interface FetchOptions {
  readonly url?: string;
  readonly file?: string;
  /** Expected sha256 of the tar; defaults to `<url>.sha256` (or `<file>.sha256` if present). */
  readonly sha256?: string;
  readonly outRoot?: string;
  readonly fetchImpl?: typeof fetch;
  readonly log?: (line: string) => void;
}

/**
 * One part of a path in the sample archive (its folder, or a file in it): letters, digits, `.`,
 * `_` and `-`, not starting with a dot. That rules out `..`, and `\` and `C:`, which Windows
 * reads as path syntax, so nothing lands outside the staging folder or names another folder to
 * replace.
 */
const SAFE_PART = /^[A-Za-z0-9_-][A-Za-z0-9._-]*$/;

const hexIn = (text: string) => /^\s*([0-9a-f]{64})/i.exec(text)?.[1]?.toLowerCase();

export async function fetchSample(
  opts: FetchOptions = {},
): Promise<{ manifest: CatalogManifest; dir: string }> {
  const { outRoot = "data/catalog", fetchImpl = fetch, log = () => {} } = opts;
  await mkdir(outRoot, { recursive: true });
  let tarFile = opts.file;
  let expected = opts.sha256;
  if (!tarFile) {
    const url = opts.url ?? process.env.CATALOG_SAMPLE_URL ?? DEFAULT_SAMPLE_URL;
    if (!expected) {
      const res = await fetchImpl(`${url}.sha256`, { headers: { "user-agent": USER_AGENT } });
      if (res.ok) expected = hexIn(await res.text());
      else await res.body?.cancel();
    }
    tarFile = path.join(outRoot, `.download-${path.basename(new URL(url).pathname)}`);
    log(`Downloading ${url}`);
    const res = await fetchImpl(url, { headers: { "user-agent": USER_AGENT } });
    if (!res.ok || !res.body) {
      throw new Error(
        `GET ${url}: HTTP ${res.status}. While the repository is private, download the release asset with ` +
          "`gh release download` and pass it with --file.",
      );
    }
    const out = createWriteStream(tarFile);
    for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  } else if (!expected) {
    try {
      expected = hexIn(await readFile(`${tarFile}.sha256`, "utf8"));
    } catch {}
  }
  const actual = await sha256File(tarFile);
  if (expected && actual !== expected)
    throw new Error(`${tarFile}: sha256 ${actual}, expected ${expected}`);
  log(
    expected
      ? `sha256 verified (${actual.slice(0, 12)}…)`
      : `sha256 ${actual} (no checksum to compare against)`,
  );

  // Unpack into a staging directory, verify every file against the manifest, then swap into place.
  const staging = path.join(outRoot, `.staging-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  let top: string | undefined;
  for await (const entry of readTar(createReadStream(tarFile, { highWaterMark: 1 << 20 }))) {
    if (entry.type !== "file") continue;
    const parts = entry.name.split("/");
    if (parts.length !== 2 || !parts.every((p) => SAFE_PART.test(p))) {
      throw new Error(`unexpected path in sample archive: ${entry.name}`);
    }
    top ??= parts[0];
    if (parts[0] !== top) throw new Error(`sample archive mixes ${top} and ${parts[0]}`);
    const target = path.join(staging, ...parts);
    await mkdir(path.dirname(target), { recursive: true });
    const out = createWriteStream(target);
    for await (const chunk of entry.stream()) {
      if (!out.write(chunk)) await once(out, "drain");
    }
    out.end();
    await once(out, "finish");
  }
  if (!top) throw new Error(`${tarFile}: empty archive`);
  const stagedDir = path.join(staging, top);
  const manifest = JSON.parse(
    await readFile(path.join(stagedDir, "manifest.json"), "utf8"),
  ) as CatalogManifest;
  for (const f of manifest.files) {
    if (!SAFE_PART.test(f.name)) throw new Error(`unexpected file in sample manifest: ${f.name}`);
    const got = await sha256File(path.join(stagedDir, f.name));
    if (got !== f.sha256) throw new Error(`${f.name}: sha256 ${got}, manifest says ${f.sha256}`);
  }
  const dir = path.join(outRoot, top);
  await rm(dir, { recursive: true, force: true });
  await rename(stagedDir, dir);
  await rm(staging, { recursive: true, force: true });
  if (!opts.file) await rm(tarFile, { force: true });
  log(
    `Installed ${manifest.catalog_version} (${manifest.kind}, ${manifest.tracks.toLocaleString("en")} tracks) in ${dir}`,
  );
  return { manifest, dir };
}
