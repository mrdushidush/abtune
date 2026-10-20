// The music personality pages: `types.html` lists the 16, `types/<slug>.html` is one. Static
// documents with no script, like the legal pages, written at build time (prerender-plugin.ts), so a
// crawler, a link preview and a browser with scripts off all read the same page.
import type { Traits } from "@abtune/engine";
import { TRAIT_LABELS, TYPE_PAGES, type TypeCopy } from "./client/strings.ts";
import { neighbors, PERSONALITIES, type Personality, TYPES_PATH } from "./personalities.ts";

export interface BuiltPage {
  /** Path in the build output: "types.html", "types/sunburst-revivalist.html". */
  readonly file: string;
  readonly html: string;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const s = TYPE_PAGES;

/** The copy for one type: every type has one (types.test.ts). */
export function typeCopy(p: Personality): TypeCopy {
  const copy = s.types[p.key];
  if (!copy) throw new Error(`no copy for ${p.name} (${p.key})`);
  return copy;
}

const traitList = (t: Traits) =>
  [
    TRAIT_LABELS.energy[t.energy],
    TRAIT_LABELS.mood[t.mood],
    TRAIT_LABELS.era[t.era],
    TRAIT_LABELS.texture[t.texture],
  ] as const;

interface Head {
  readonly title: string;
  readonly description: string;
  /** The page's absolute address. */
  readonly canonical: string;
  readonly ogTitle: string;
}

function document(url: string, stylesheet: string, head: Head, main: string): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="description" content="${esc(head.description)}" />
    <meta name="theme-color" content="#0b0b12" />
    <link rel="canonical" href="${esc(head.canonical)}" />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="ABTune" />
    <meta property="og:title" content="${esc(head.ogTitle)}" />
    <meta property="og:description" content="${esc(head.description)}" />
    <meta property="og:url" content="${esc(head.canonical)}" />
    <meta property="og:image" content="${esc(url)}og.png" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <link rel="icon" href="/favicon.ico" sizes="32x32" />
    <link rel="icon" href="/icon.svg" type="image/svg+xml" />
    <link rel="stylesheet" crossorigin href="${esc(stylesheet)}" />
    <title>${esc(head.title)}</title>
  </head>
  <body>
    <main class="legal">
${main}
      <footer>
        <a href="/privacy">${esc(s.nav.privacy)}</a>
        <a href="/terms">${esc(s.nav.terms)}</a>
      </footer>
    </main>
  </body>
</html>
`;
}

const nav = (extra = "") =>
  `      <nav aria-label="ABTune">
        <a href="/">${esc(s.nav.home)}</a>${extra}
      </nav>`;

const cta = () => `      <h2>${esc(s.cta.heading)}</h2>
      <p>${esc(s.cta.body)}</p>
      <p><a class="cta" href="/">${esc(s.cta.link)}</a></p>`;

const href = (p: Personality) => `/${TYPES_PATH}/${p.slug}`;

/** One type's page. `url` is the site's address, ending with "/". */
export function typePage(url: string, stylesheet: string, p: Personality): BuiltPage {
  const copy = typeCopy(p);
  const main = `${nav(`
        <a href="/${TYPES_PATH}">${esc(s.nav.all)}</a>`)}

      <p class="kicker">${esc(s.page.kicker)}</p>
      <h1>${esc(p.name)}</h1>
      <ul class="traits" aria-label="Traits">
${traitList(p.traits)
  .map((l) => `        <li>${esc(l)}</li>`)
  .join("\n")}
      </ul>
      <p class="lead">${esc(copy.lead)}</p>
      <p>${esc(copy.body)}</p>

      <h2>${esc(s.page.songs)}</h2>
      <ul>
${copy.songs.map(([title, artist]) => `        <li>${esc(s.page.song(title, artist))}</li>`).join("\n")}
      </ul>
      <p class="note">${esc(s.page.songsAbout(p.traits))}</p>

      <h2>${esc(s.page.neighbors)}</h2>
      <ul>
${neighbors(p)
  .map(
    ({ trait, to }) =>
      `        <li><a href="${href(to)}">${esc(to.name)}</a>: ${esc(s.page.neighbor(trait, p.traits[trait], to.traits[trait]))}</li>`,
  )
  .join("\n")}
      </ul>

${cta()}`;
  return {
    file: `${TYPES_PATH}/${p.slug}.html`,
    html: document(
      url,
      stylesheet,
      {
        title: s.page.title(p.name),
        description: s.page.description(copy.lead),
        canonical: `${url}${TYPES_PATH}/${p.slug}`,
        ogTitle: `${p.name} · ABTune`,
      },
      main,
    ),
  };
}

/** The list of all 16, grouped by energy and mood (HANDOFF §9.6's rows). */
export function hubPage(url: string, stylesheet: string): BuiltPage {
  const groups = (["hi", "lo"] as const).flatMap((energy) =>
    (["bright", "dark"] as const).map((mood) => {
      const members = PERSONALITIES.filter(
        (p) => p.traits.energy === energy && p.traits.mood === mood,
      );
      return `      <h2>${esc(s.hub.group(energy, mood))}</h2>
      <ul class="types">
${members
  .map(
    (p) =>
      `        <li><a href="${href(p)}">${esc(p.name)}</a> <span>${esc(`${TRAIT_LABELS.era[p.traits.era]} · ${TRAIT_LABELS.texture[p.traits.texture]}`)}</span><br />${esc(typeCopy(p).lead)}</li>`,
  )
  .join("\n")}
      </ul>`;
    }),
  );
  const main = `${nav()}

      <h1>${esc(s.hub.heading)}</h1>
      <p class="lead">${esc(s.hub.intro)}</p>

      <h2>${esc(s.hub.traitsHeading)}</h2>
      <dl>
${s.hub.traits
  .map(
    (tr) => `        <dt>${esc(`${tr.name}: ${tr.sides}`)}</dt>
        <dd>${esc(tr.about)}</dd>`,
  )
  .join("\n")}
      </dl>

${groups.join("\n\n")}

${cta()}`;
  return {
    file: `${TYPES_PATH}.html`,
    html: document(
      url,
      stylesheet,
      {
        title: s.hub.title,
        description: s.hub.description,
        canonical: `${url}${TYPES_PATH}`,
        ogTitle: `${s.hub.heading} · ABTune`,
      },
      main,
    ),
  };
}

/** The hub and the 16 pages. */
export function typePages(url: string, stylesheet: string): BuiltPage[] {
  return [hubPage(url, stylesheet), ...PERSONALITIES.map((p) => typePage(url, stylesheet, p))];
}
