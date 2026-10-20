// What a crawler reads without running the app: the prerendered start screen and its structured
// data, the canonical address, robots.txt, the sitemap and llms.txt, and a real 404 for anything else.
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { archetypeName } from "@abtune/engine";
import { describe, expect, it } from "vitest";
import { IL_PACK } from "../src/client/lib/locale.ts";
import { landingHtml, structuredData } from "../src/client/prerender.tsx";
import { packName, TYPE_PAGES as TYPE_PAGES_COPY, t } from "../src/client/strings.ts";
import { PERSONALITIES } from "../src/personalities.ts";
import {
  CRAWLER_FILES,
  createApp,
  LEGAL_PAGES,
  TYPE_PAGES,
  URL_PLACEHOLDER,
} from "../src/server/app.ts";

const client = fileURLToPath(new URL("../src/client/", import.meta.url));
const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));
const source = (file: string) => readFile(path.join(client, file), "utf8");

/** Text as a browser shows it: the entities renderToStaticMarkup writes, decoded. */
const shown = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
if (!bank) throw new Error("seed bank failed to load");

describe("the prerendered start screen", () => {
  const html = landingHtml(bank);
  const text = shown(html);

  it("says what ABTune is, how it works and the common questions, with the start button", () => {
    for (const s of [t.tagline, t.pitch, t.setup.start, t.about.how, t.about.faq])
      expect(text, s).toContain(s);
    for (const step of t.about.steps) {
      expect(text).toContain(step.title);
      expect(text).toContain(step.body);
    }
    for (const { q, a } of t.about.questions) {
      expect(text).toContain(q);
      expect(text).toContain(a);
    }
  });

  it("doesn't depend on the machine that built it", () => {
    expect(landingHtml(bank)).toBe(html);
    // A fixed English locale: the Israeli pack is offered but not switched on.
    const row = html.split("<label").find((l) => l.includes(packName(IL_PACK)));
    expect(row).toContain('aria-checked="false"');
  });

  it("names personality types that exist", () => {
    const names = new Set<string>();
    for (const energy of ["hi", "lo"] as const)
      for (const mood of ["bright", "dark"] as const)
        for (const era of ["retro", "modern"] as const)
          for (const texture of ["organic", "electric"] as const)
            names.add(archetypeName({ energy, mood, era, texture }));
    expect(names.size).toBe(16);
    const step = t.about.steps[1]?.body ?? "";
    const named = [...names].filter((n) => step.includes(n));
    expect(named).toEqual(["Sunburst Revivalist", "Night-Drive Ghost"]);
  });

  it("links the page that lists all 16", () => {
    expect(html).toContain('href="/types"');
  });
});

describe("structured data", () => {
  const url = "https://abtune.example/";
  const data = structuredData(url) as { "@graph": Record<string, unknown>[] };
  const of = (type: string) => data["@graph"].find((n) => n["@type"] === type);

  it("names the site and the app at the page's URL", () => {
    expect(of("WebSite")).toMatchObject({ name: "ABTune", url });
    expect(of("WebApplication")).toMatchObject({ name: "ABTune", url, isAccessibleForFree: true });
  });

  it("answers exactly the questions the page shows, word for word", () => {
    const faq = of("FAQPage") as {
      mainEntity: { name: string; acceptedAnswer: { text: string } }[];
    };
    expect(faq.mainEntity.map((e) => [e.name, e.acceptedAnswer.text])).toEqual(
      t.about.questions.map(({ q, a }) => [q, a]),
    );
  });
});

describe("the sources crawlers read", () => {
  it("give the start page a canonical address the server fills in", async () => {
    expect(await source("index.html")).toContain(
      `<link rel="canonical" href="${URL_PLACEHOLDER}" />`,
    );
  });

  it("list every page in the sitemap, and point robots.txt at it", async () => {
    const sitemap = await source("public/sitemap.xml");
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs).toEqual([
      URL_PLACEHOLDER,
      ...[...LEGAL_PAGES, ...TYPE_PAGES].map((p) => `${URL_PLACEHOLDER}${p}`),
    ]);
    const robots = await source("public/robots.txt");
    expect(robots).toContain("Disallow: /api/");
    expect(robots).toContain(`Sitemap: ${URL_PLACEHOLDER}sitemap.xml`);
  });

  it("link the same pages from llms.txt", async () => {
    const llms = await source("public/llms.txt");
    expect(llms.startsWith("# ABTune\n\n> ")).toBe(true);
    for (const p of ["", ...LEGAL_PAGES, ...TYPE_PAGES])
      expect(llms).toContain(`(${URL_PLACEHOLDER}${p})`);
    // Each type's line is its page's lead, word for word.
    for (const p of PERSONALITIES)
      expect(llms).toContain(
        `- [${p.name}](${URL_PLACEHOLDER}types/${p.slug}): ${TYPE_PAGES_COPY.types[p.key]?.lead}\n`,
      );
  });
});

describe("the server, for crawlers", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "abtune-crawlers-"));
  await writeFile(path.join(dir, "index.html"), `<link rel="canonical" href="${URL_PLACEHOLDER}">`);
  await writeFile(path.join(dir, "404.html"), "<h1>Page not found</h1>");
  for (const [file] of CRAWLER_FILES)
    await writeFile(path.join(dir, file), await source(`public/${file}`));
  const app = createApp({
    bank,
    version: "9.9.9",
    staticRoot: dir,
    publicUrl: "https://music.example.org/",
  });

  it("fills in the public URL", async () => {
    expect(await (await app.request("/")).text()).toBe(
      '<link rel="canonical" href="https://music.example.org/">',
    );
    const robots = await app.request("/robots.txt");
    expect(robots.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    expect(await robots.text()).toContain("Sitemap: https://music.example.org/sitemap.xml");
    const sitemap = await app.request("/sitemap.xml");
    expect(sitemap.headers.get("content-type")).toBe("application/xml; charset=utf-8");
    expect(await sitemap.text()).toContain("<loc>https://music.example.org/privacy</loc>");
    const llms = await app.request("/llms.txt");
    expect(llms.headers.get("content-type")).toBe("text/plain; charset=utf-8");
    const body = await llms.text();
    expect(body).toContain("(https://music.example.org/terms)");
    expect(body).not.toContain(URL_PLACEHOLDER);
  });

  it("answers any other address with a real 404, not the app", async () => {
    for (const route of ["/nope", "/sitemap", "/privacy/x", "/s/abc", "/assets/gone.js"]) {
      const res = await app.request(route);
      expect(res.status, route).toBe(404);
      expect(res.headers.get("content-type"), route).toContain("text/html");
      expect(await res.text(), route).toBe("<h1>Page not found</h1>");
    }
  });

  it("still answers 404 when the page wasn't built", async () => {
    const bare = await mkdtemp(path.join(tmpdir(), "abtune-crawlers-"));
    await writeFile(path.join(bare, "index.html"), "<p>the app</p>");
    const unbuilt = createApp({ bank, version: "9.9.9", staticRoot: bare });
    for (const route of ["/nope", "/llms.txt"])
      expect((await unbuilt.request(route)).status, route).toBe(404);
  });
});
