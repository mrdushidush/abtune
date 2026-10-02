// Opening the dump archives: .tar and .tar.zst stream through our tar reader (node:zlib has
// zstd); .tar.bz2 (MusicBrainz) is extracted by the system tar, which is much faster at bz2.
import { spawn, spawnSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import path from "node:path";
import { createZstdDecompress } from "node:zlib";
import { readTar, type TarEntry } from "./tar.ts";

/** Decompressed bytes of a `.tar` or `.tar.zst` file. */
export function openTarBytes(file: string): AsyncIterable<Buffer> {
  const input = createReadStream(file, { highWaterMark: 1 << 20 });
  if (file.endsWith(".tar")) return input;
  if (file.endsWith(".tar.zst")) {
    const zstd = createZstdDecompress();
    input.on("error", (e) => zstd.destroy(e));
    zstd.on("close", () => input.destroy());
    return input.pipe(zstd);
  }
  throw new Error(`Unsupported archive (want .tar or .tar.zst): ${file}`);
}

export function openTar(file: string): AsyncGenerator<TarEntry> {
  return readTar(openTarBytes(file));
}

/** SPDX-ish id from a dump's COPYING text, or undefined if unrecognized. */
export function licenseOf(copying: string): string | undefined {
  const head = copying.slice(0, 600);
  if (/CC0 1\.0 Universal/.test(head)) return "CC0-1.0";
  if (/Attribution-NonCommercial-ShareAlike 3\.0 US/.test(head)) return "CC-BY-NC-SA-3.0-US";
  if (/Attribution-NonCommercial-ShareAlike 3\.0/.test(head)) return "CC-BY-NC-SA-3.0";
  return undefined;
}

export function assertLicense(copying: string, expected: string, source: string): void {
  const found = licenseOf(copying);
  if (found !== expected) {
    throw new Error(
      `${source}: COPYING says ${found ?? "an unrecognized license"}, expected ${expected}. ` +
        "The source license changed; review docs/DATA_LICENSES.md before building.",
    );
  }
}

/** The system tar: bsdtar on Windows (bz2 built in), GNU tar or bsdtar elsewhere. */
function systemTar(): { cmd: string; extra: string[] } {
  if (process.platform === "win32") {
    return {
      cmd: path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe"),
      extra: [],
    };
  }
  // Parallel bzip2 when available: a 7 GB MusicBrainz dump decompresses several times faster.
  const lbzip2 = spawnSync("lbzip2", ["--version"], { stdio: "ignore" }).status === 0;
  return { cmd: "tar", extra: lbzip2 ? ["--use-compress-program=lbzip2"] : [] };
}

/**
 * Extract named members of a (compressed) tar into `outDir` with the system tar.
 * Members missing from the archive are reported, not fatal; callers decide.
 */
export async function extractWithSystemTar(
  archive: string,
  members: readonly string[],
  outDir: string,
): Promise<{ missing: string[] }> {
  await mkdir(outDir, { recursive: true });
  const { cmd, extra } = systemTar();
  const args = [...extra, "-x", "-f", archive, "-C", outDir, ...members];
  const stderr: string[] = [];
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });
    child.stderr.setEncoding("utf8").on("data", (d: string) => stderr.push(d));
    child.on("error", reject);
    child.on("close", (c) => resolve(c ?? 1));
  });
  const missing: string[] = [];
  for (const m of members) {
    try {
      await access(path.join(outDir, m));
    } catch {
      missing.push(m);
    }
  }
  if (code !== 0 && missing.length === 0) {
    throw new Error(`${cmd} exited ${code} extracting ${archive}: ${stderr.join("").trim()}`);
  }
  return { missing };
}
