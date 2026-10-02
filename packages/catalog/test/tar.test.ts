import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { zstdCompressSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { licenseOf, openTar } from "../src/archive.ts";
import { readTar, tarHeader, writeTar } from "../src/tar.ts";

async function* chunked(buf: Buffer, size: number): AsyncGenerator<Buffer> {
  for (let i = 0; i < buf.length; i += size) yield buf.subarray(i, i + size);
}

const files = [
  { name: "a.txt", data: Buffer.from("hello") },
  { name: "dir/b.bin", data: Buffer.alloc(1300, 7) },
  { name: "empty", data: Buffer.alloc(0) },
];

async function collect(source: AsyncIterable<Buffer>) {
  const out: { name: string; data: Buffer }[] = [];
  for await (const e of readTar(source)) out.push({ name: e.name, data: await e.buffer() });
  return out;
}

describe("tar", () => {
  it("round-trips through writeTar/readTar at any chunk size", async () => {
    const tar = Buffer.concat([...writeTar(files)]);
    for (const size of [1, 7, 512, 100_000]) {
      expect(await collect(chunked(tar, size))).toEqual(files);
    }
  });

  it("skips unread and partially read bodies", async () => {
    const tar = Buffer.concat([...writeTar(files)]);
    const names: string[] = [];
    for await (const e of readTar(chunked(tar, 300))) {
      names.push(e.name);
      if (e.name === "dir/b.bin") {
        for await (const _ of e.stream()) break; // read one chunk, abandon the rest
      }
    }
    expect(names).toEqual(["a.txt", "dir/b.bin", "empty"]);
  });

  it("honors PAX path and size records and GNU long names", async () => {
    const long = `${"x".repeat(150)}/file.json`;
    const paxBody = paxRecord("path", long);
    const paxHeader = tarHeader("PaxHeader", paxBody.length);
    paxHeader.write("x", 156, 1, "ascii");
    fixChecksum(paxHeader);
    const gnuName = Buffer.from("gnu/long/name/".repeat(10));
    const gnuHeader = tarHeader("././@LongLink", gnuName.length);
    gnuHeader.write("L", 156, 1, "ascii");
    fixChecksum(gnuHeader);
    const body = Buffer.from("{}");
    const tar = Buffer.concat([
      paxHeader,
      pad(paxBody),
      tarHeader("short-a", body.length),
      pad(body),
      gnuHeader,
      pad(gnuName),
      tarHeader("short-b", body.length),
      pad(body),
      Buffer.alloc(1024),
    ]);
    const got = await collect(chunked(tar, 64));
    expect(got.map((e) => e.name)).toEqual([long, gnuName.toString()]);
  });

  it("reads .tar.zst archives from disk", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "abtune-tar-"));
    const file = path.join(dir, "x.tar.zst");
    await writeFile(file, zstdCompressSync(Buffer.concat([...writeTar(files)])));
    const out: string[] = [];
    for await (const e of openTar(file)) out.push(`${e.name}:${(await e.buffer()).length}`);
    expect(out).toEqual(["a.txt:5", "dir/b.bin:1300", "empty:0"]);
  });

  it("recognizes the dump licenses", () => {
    expect(licenseOf("Creative Commons Legal Code\n\nCC0 1.0 Universal\n")).toBe("CC0-1.0");
    expect(licenseOf("  Attribution-NonCommercial-ShareAlike 3.0 US\n  C O M M O N S")).toBe(
      "CC-BY-NC-SA-3.0-US",
    );
    expect(licenseOf("MIT License")).toBeUndefined();
  });
});

/** "<len> key=value\n", where <len> counts the whole record including its own digits. */
function paxRecord(key: string, value: string): Buffer {
  const rest = ` ${key}=${value}\n`;
  let len = rest.length + 1;
  while (String(len).length + rest.length !== len) len = String(len).length + rest.length;
  return Buffer.from(`${len}${rest}`);
}

function pad(b: Buffer): Buffer {
  const rem = (512 - (b.length % 512)) % 512;
  return Buffer.concat([b, Buffer.alloc(rem)]);
}

function fixChecksum(h: Buffer): void {
  h.fill(0x20, 148, 156);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
}
