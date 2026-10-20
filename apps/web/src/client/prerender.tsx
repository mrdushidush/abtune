// Build time only (prerender-plugin.ts): the start screen as HTML, and the page's structured data,
// for crawlers that run no script. The app's createRoot replaces the HTML on load.
import type { Bank } from "@abtune/engine";
import { renderToStaticMarkup } from "react-dom/server";
import { REPO_URL } from "./components/SourceLink.tsx";
import { Setup } from "./screens/Setup.tsx";
import { t } from "./strings.ts";

/**
 * The start screen as a first visit sees it before the server answers. The locale is fixed, so the
 * page doesn't depend on the machine that built it: English, so no Israeli pack.
 */
export function landingHtml(bank: Bank): string {
  return renderToStaticMarkup(
    <Setup
      bank={bank}
      last={null}
      health={{ kind: "loading" }}
      onStart={() => {}}
      locale={{ languages: ["en-US"], timeZone: "UTC" }}
    />,
  );
}

/**
 * schema.org JSON-LD for the page at `url` (ends with "/"): the site, the app, and the questions
 * the page answers, word for word.
 */
export function structuredData(url: string): object {
  return {
    "@context": "https://schema.org",
    "@graph": [
      { "@type": "WebSite", "@id": `${url}#website`, name: "ABTune", url, inLanguage: "en" },
      {
        "@type": "WebApplication",
        "@id": `${url}#app`,
        name: "ABTune",
        url,
        description: `${t.tagline} ${t.pitch}`,
        applicationCategory: "MultimediaApplication",
        operatingSystem: "Any (in a web browser)",
        isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
        author: { "@type": "Person", name: "David", url: "https://github.com/mrdushidush" },
        sameAs: [REPO_URL],
      },
      {
        "@type": "FAQPage",
        "@id": `${url}#faq`,
        mainEntity: t.about.questions.map(({ q, a }) => ({
          "@type": "Question",
          name: q,
          acceptedAnswer: { "@type": "Answer", text: a },
        })),
      },
    ],
  };
}
