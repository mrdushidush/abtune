// The music personality pages: one per type with its copy and songs, linked to each other and to the
// quiz, documents with no script, and served at /types and /types/<slug>.
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadBankFromDisk } from "@abtune/bank/node";
import { archetypeName, RETRO_BEFORE } from "@abtune/engine";
import { describe, expect, it } from "vitest";
import { TRAIT_LABELS, TYPE_PAGES } from "../src/client/strings.ts";
import { neighbors, PERSONALITIES, slugOf, TYPES_PATH } from "../src/personalities.ts";
import { createApp, TYPE_PAGES as ROUTES } from "../src/server/app.ts";
import { hubPage, typeCopy, typePage, typePages } from "../src/type-pages.ts";

const questionsDir = fileURLToPath(new URL("../../../data/questions", import.meta.url));
const url = "https://abtune.example/";
const css = "/assets/styles-test.css";

/** Text as a browser shows it. */
const shown = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

const words = (s: string) => s.split(/\s+/).filter(Boolean).length;
const links = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]+)"/g)].map((m) => m[1]);

describe("the 16 personalities", () => {
  it("are the engine's 16 types, each at its own address", () => {
    expect(PERSONALITIES).toHaveLength(16);
    for (const p of PERSONALITIES) expect(archetypeName(p.traits)).toBe(p.name);
    expect(new Set(PERSONALITIES.map((p) => p.slug)).size).toBe(16);
    expect(PERSONALITIES.map((p) => p.slug)).toContain("sunburst-revivalist");
    expect(slugOf("Bass-Drop Outlaw")).toBe("bass-drop-outlaw");
    expect(slugOf("Lo-fi Sunbather")).toBe("lo-fi-sunbather");
  });

  it("each has a one-line lead, a short body and five songs, and no song is on two pages", () => {
    expect(Object.keys(TYPE_PAGES.types).sort()).toEqual(PERSONALITIES.map((p) => p.key).sort());
    const songs = new Set<string>();
    for (const p of PERSONALITIES) {
      const { lead, body, songs: list } = typeCopy(p);
      // The lead is also the meta description's start, which search results cut near 160.
      expect(TYPE_PAGES.page.description(lead).length, p.name).toBeLessThanOrEqual(160);
      expect(words(body), p.name).toBeGreaterThanOrEqual(45);
      expect(words(body), p.name).toBeLessThanOrEqual(90);
      expect(list, p.name).toHaveLength(5);
      for (const [title, artist] of list) songs.add(`${title} · ${artist}`);
    }
    expect(songs.size).toBe(16 * 5);
  });

  it("put the era where the engine puts it", () => {
    for (const p of PERSONALITIES) {
      const { lead } = typeCopy(p);
      if (p.traits.era === "retro") expect(lead, p.name).toContain(`before ${RETRO_BEFORE}`);
      else expect(lead, p.name).toContain(`${RETRO_BEFORE} on`);
    }
  });

  it("each have four neighbors, one trait away and back", () => {
    for (const p of PERSONALITIES) {
      const near = neighbors(p);
      expect(near.map((n) => n.trait)).toEqual(["energy", "mood", "era", "texture"]);
      for (const { trait, to } of near) {
        expect(to.traits[trait]).not.toBe(p.traits[trait]);
        expect({ ...to.traits, [trait]: p.traits[trait] }).toEqual(p.traits);
        expect(neighbors(to).find((n) => n.trait === trait)?.to).toBe(p);
      }
    }
  });
});

describe("a type's page", () => {
  const pages = typePages(url, css);
  const addresses = new Set(["/", "/privacy", "/terms", ...ROUTES.map((r) => `/${r}`)]);

  it("is a document with no script, the built stylesheet, a canonical address and link previews", () => {
    expect(pages.map((p) => p.file)).toEqual([
      `${TYPES_PATH}.html`,
      ...PERSONALITIES.map((p) => `${TYPES_PATH}/${p.slug}.html`),
    ]);
    for (const { file, html } of pages) {
      const address = `${url}${file.replace(/\.html$/, "")}`;
      expect(html.startsWith("<!doctype html>"), file).toBe(true);
      expect(html, file).not.toContain("<script");
      expect(html, file).toContain(`<link rel="stylesheet" crossorigin href="${css}" />`);
      expect(html, file).toContain(`<link rel="canonical" href="${address}" />`);
      expect(html, file).toContain(`<meta property="og:url" content="${address}" />`);
      expect(html, file).toContain(`<meta property="og:image" content="${url}og.png" />`);
      expect(html.match(/<h1>/g), file).toHaveLength(1);
    }
  });

  it("shows the name, the four traits, the copy, the songs and the way to the quiz", () => {
    for (const p of PERSONALITIES) {
      const { html } = typePage(url, css, p);
      const text = shown(html);
      const copy = typeCopy(p);
      expect(html).toContain(`<title>${p.name}: Music Personality Type · ABTune</title>`);
      expect(html).toContain(`<h1>${p.name}</h1>`);
      for (const [trait, side] of Object.entries(p.traits))
        expect(text, p.name).toContain(
          (TRAIT_LABELS as Record<string, Record<string, string>>)[trait]?.[side],
        );
      for (const s of [
        copy.lead,
        copy.body,
        TYPE_PAGES.page.songsAbout(p.traits),
        TYPE_PAGES.cta.body,
      ])
        expect(text, p.name).toContain(s);
      for (const [title, artist] of copy.songs)
        expect(text, p.name).toContain(TYPE_PAGES.page.song(title, artist));
      expect(html).toContain(`<a class="cta" href="/">${TYPE_PAGES.cta.link}</a>`);
    }
  });

  it("links its four neighbors and the list, and only addresses that exist", () => {
    for (const p of PERSONALITIES) {
      const out = links(typePage(url, css, p).html);
      for (const { to } of neighbors(p)) expect(out, p.name).toContain(`/${TYPES_PATH}/${to.slug}`);
      expect(out, p.name).toContain(`/${TYPES_PATH}`);
      for (const href of out)
        expect(addresses.has(href as string), `${p.name}: ${href}`).toBe(true);
    }
  });

  it("escapes what it shows", () => {
    const porch = PERSONALITIES.find((p) => p.name === "Porch Poet");
    if (!porch) throw new Error("no Porch Poet");
    expect(typePage(url, css, porch).html).toContain(
      "Three Little Birds by Bob Marley &amp; The Wailers",
    );
  });
});

describe("the list of all 16", () => {
  const { html } = hubPage(url, css);
  const text = shown(html);

  it("links every type, with its lead", () => {
    const out = links(html);
    for (const p of PERSONALITIES) {
      expect(out).toContain(`/${TYPES_PATH}/${p.slug}`);
      expect(text).toContain(typeCopy(p).lead);
    }
  });

  it("explains the four traits, with the engine's cut-offs", () => {
    expect(html).toContain(`<h1>${TYPE_PAGES.hub.heading}</h1>`);
    for (const tr of TYPE_PAGES.hub.traits) expect(text).toContain(tr.about);
    expect(text).toContain("+0.15 on a scale from −1 to +1");
    expect(text).toContain("from the 2000s on make up at least 35% of your decade mix");
  });
});

describe("the pages' addresses", async () => {
  const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
  if (!bank) throw new Error("seed bank failed to load");
  const dir = await mkdtemp(path.join(tmpdir(), "abtune-types-"));
  await mkdir(path.join(dir, TYPES_PATH));
  await writeFile(path.join(dir, "index.html"), "<p>the app</p>");
  await writeFile(path.join(dir, "404.html"), "<h1>Page not found</h1>");
  for (const { file, html } of typePages("__ABTUNE_URL__", css))
    await writeFile(path.join(dir, file), html);
  const app = createApp({
    bank,
    version: "9.9.9",
    staticRoot: dir,
    publicUrl: "https://music.example.org/",
  });

  it("serves the list and every type, with or without a slash or .html, with the public URL in", async () => {
    for (const name of ROUTES)
      for (const route of [`/${name}`, `/${name}/`, `/${name}.html`]) {
        const res = await app.request(route);
        expect(res.status, route).toBe(200);
        expect(res.headers.get("content-type"), route).toContain("text/html");
        expect(res.headers.get("cache-control"), route).toBe("no-cache");
        const html = await res.text();
        expect(html, route).toContain(
          `<link rel="canonical" href="https://music.example.org/${name}" />`,
        );
        expect(html, route).not.toContain("__ABTUNE_URL__");
      }
  });

  it("answers 404 for a type that doesn't exist", async () => {
    for (const route of ["/types/nope", "/types/sunburst-revivalist/x", "/Types", "/type"])
      expect((await app.request(route)).status, route).toBe(404);
  });
});
