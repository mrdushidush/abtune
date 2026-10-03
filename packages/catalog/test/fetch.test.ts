import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { fetchSample } from "../src/fetch.ts";
import { writeTar } from "../src/tar.ts";

const root = await mkdtemp(path.join(tmpdir(), "abtune-fetch-"));
afterAll(() => rm(root, { recursive: true, force: true }));

const manifest = (files: { name: string; sha256: string }[] = []) =>
  Buffer.from(
    JSON.stringify({ name: "abtune-catalog", catalog_version: "t", kind: "dev-sample", files }),
  );

/** A sample archive with these entries, next to a folder the archive must not touch. */
async function archive(name: string, entries: { name: string; data: Buffer }[]) {
  const dir = path.join(root, name);
  await mkdir(path.join(dir, "victim"), { recursive: true });
  await writeFile(path.join(dir, "victim", "keep.txt"), "keep");
  const file = path.join(dir, "sample.tar");
  await writeFile(file, Buffer.concat([...writeTar(entries)]));
  return { file, outRoot: path.join(dir, "catalog"), victim: path.join(dir, "victim") };
}

describe("catalog fetch", () => {
  it("refuses archive paths that could leave the staging folder", async () => {
    const bad = [
      "../victim/manifest.json",
      "..\\victim/manifest.json",
      "sample/..\\..\\..\\victim\\x.txt",
      "C:victim/manifest.json",
      ".hidden/manifest.json",
      "sample/sub/manifest.json",
    ];
    for (const [i, name] of bad.entries()) {
      const a = await archive(`bad${i}`, [{ name, data: manifest() }]);
      await expect(fetchSample({ file: a.file, outRoot: a.outRoot })).rejects.toThrow(
        /unexpected path/,
      );
      expect(await readdir(a.victim)).toEqual(["keep.txt"]);
    }
  });

  it("refuses manifest file names outside the sample folder", async () => {
    const a = await archive("manifest", [
      {
        name: "sample/manifest.json",
        data: manifest([{ name: "..\\..\\victim\\keep.txt", sha256: "0".repeat(64) }]),
      },
    ]);
    await expect(fetchSample({ file: a.file, outRoot: a.outRoot })).rejects.toThrow(
      /unexpected file/,
    );
  });
});
