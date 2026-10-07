// Add to home screen: the web app manifest, its icons, and the page's links to them.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/server/app.ts";

const clientDir = fileURLToPath(new URL("../src/client", import.meta.url));
const publicDir = path.join(clientDir, "public");
const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));

interface ManifestIcon {
  src: string;
  sizes: string;
  type: string;
  purpose?: string;
}

const manifest = JSON.parse(
  await readFile(path.join(publicDir, "manifest.webmanifest"), "utf8"),
) as {
  name: string;
  short_name: string;
  start_url: string;
  display: string;
  icons: ManifestIcon[];
};

/** Width and height from a PNG's IHDR chunk. */
async function pngSize(file: string): Promise<string> {
  const buf = await readFile(file);
  expect(buf.subarray(1, 4).toString("latin1"), file).toBe("PNG");
  return `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`;
}

describe("web app manifest", () => {
  it("has what Chrome needs to offer an install", () => {
    expect(manifest.name).toBe("ABTune");
    expect(manifest.short_name).toBe("ABTune");
    expect(manifest.start_url).toBe("/");
    expect(manifest.display).toBe("standalone");
    const any = manifest.icons.filter((i) => (i.purpose ?? "any") === "any");
    expect(any.map((i) => i.sizes)).toEqual(expect.arrayContaining(["192x192", "512x512"]));
    expect(manifest.icons.some((i) => i.purpose === "maskable")).toBe(true);
  });

  it("lists icons that exist at the sizes it claims", async () => {
    for (const icon of manifest.icons) {
      const file = path.join(publicDir, icon.src);
      if (icon.type === "image/png") expect(await pngSize(file), icon.src).toBe(icon.sizes);
      else expect((await readFile(file, "utf8")).startsWith("<svg"), icon.src).toBe(true);
    }
    expect(await pngSize(path.join(publicDir, "apple-touch-icon.png"))).toBe("180x180");
  });

  it("is linked from the page, with the icons", async () => {
    const html = await readFile(path.join(clientDir, "index.html"), "utf8");
    for (const href of [
      "/manifest.webmanifest",
      "/apple-touch-icon.png",
      "/icon.svg",
      "/favicon.ico",
    ]) {
      expect(html, href).toContain(`href="${href}"`);
      await readFile(path.join(publicDir, href));
    }
  });

  it("is served as a manifest", async () => {
    const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
    if (!bank) throw new Error("seed bank failed to load");
    const app = createApp({ bank, version: "9.9.9", staticRoot: publicDir });
    const res = await app.request("/manifest.webmanifest");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/manifest+json");
    const ico = await app.request("/favicon.ico");
    expect(ico.status).toBe(200);
    expect(ico.headers.get("content-type")).not.toContain("text/html");
  });
});
