// The privacy and terms pages: served at clean addresses, and the privacy page names everything the
// code keeps or counts, so a new storage key or counter can't land without it.
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { describe, expect, it } from "vitest";
import { SERVER_EVENTS, STAT_EVENTS } from "../src/api-types.ts";
import { createApp, LEGAL_PAGES } from "../src/server/app.ts";

const client = fileURLToPath(new URL("../src/client/", import.meta.url));
const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));
const page = (name: string) => readFile(path.join(client, `${name}.html`), "utf8");

/** Every client source file, tests aside. */
async function clientSources(): Promise<string[]> {
  const entries = await readdir(client, { recursive: true, withFileTypes: true });
  return Promise.all(
    entries
      .filter((e) => e.isFile() && /\.tsx?$/.test(e.name))
      .map((e) => readFile(path.join(e.parentPath, e.name), "utf8")),
  );
}

describe("the privacy page", () => {
  it("names every local storage key the app uses", async () => {
    const keys = new Set<string>();
    for (const src of await clientSources()) {
      for (const m of src.matchAll(/_?KEY = "(abtune\.[^"]+)"/g)) keys.add(m[1] as string);
      // A key written without a constant counts too.
      for (const m of src.matchAll(/setItem\(\s*"([^"]+)"/g)) keys.add(m[1] as string);
    }
    expect([...keys].sort()).toEqual([
      "abtune.app.v1",
      "abtune.counted",
      "abtune.feedback.v1",
      "abtune.via",
      "abtune.via.quiz",
    ]);
    const privacy = await page("privacy");
    for (const key of keys) expect(privacy, key).toContain(`<code>${key}</code>`);
  });

  it("names every count the server can keep", async () => {
    const privacy = await page("privacy");
    for (const name of [...STAT_EVENTS, ...SERVER_EVENTS])
      expect(privacy, name).toContain(`<code>${name}</code>`);
  });

  it("gives the contact on both pages, and loads no script", async () => {
    for (const name of LEGAL_PAGES) {
      const html = await page(name);
      expect(html, name).toContain('href="mailto:mrdushidush@gmail.com"');
      expect(html, name).toContain("Last updated");
      expect(html, name).not.toContain("<script");
      expect(html, name).toContain('<link rel="stylesheet" href="./styles.css" />');
    }
  });
});

describe("the legal pages' addresses", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
  if (!bank) throw new Error("seed bank failed to load");
  const dir = await mkdtemp(path.join(tmpdir(), "abtune-legal-"));
  await writeFile(path.join(dir, "index.html"), "<p>the app</p>");
  await writeFile(path.join(dir, "privacy.html"), "<h1>Privacy</h1>");
  await writeFile(path.join(dir, "terms.html"), "<h1>Terms of use</h1>");
  const app = createApp({ bank, version: "9.9.9", staticRoot: dir });

  it("serves /privacy and /terms, with or without a slash or .html", async () => {
    // The app's page first, so each page has to come from its own file.
    expect(await (await app.request("/")).text()).toBe("<p>the app</p>");
    for (const [name, heading] of [
      ["privacy", "<h1>Privacy</h1>"],
      ["terms", "<h1>Terms of use</h1>"],
    ] as const)
      for (const route of [`/${name}`, `/${name}/`, `/${name}.html`]) {
        const res = await app.request(route);
        expect(res.status, route).toBe(200);
        expect(res.headers.get("content-type"), route).toContain("text/html");
        expect(res.headers.get("cache-control"), route).toBe("no-cache");
        expect(await res.text(), route).toBe(heading);
      }
    // Anything else is not found (crawlers.test.ts).
    for (const route of ["/privacy/x", "/privacypolicy", "/Privacy"])
      expect((await app.request(route)).status, route).toBe(404);
  });

  it("answers 404 when a page wasn't built", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "abtune-legal-"));
    await writeFile(path.join(bare, "index.html"), "<p>the app</p>");
    const res = await createApp({ bank, version: "9.9.9", staticRoot: bare }).request("/terms");
    expect(res.status).toBe(404);
  });
});
