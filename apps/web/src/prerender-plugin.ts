import { loadBankFromDisk } from "@abtune/bank/node";
import react from "@vitejs/plugin-react";
import { createServer, type Plugin } from "vite";

/** The server's URL_PLACEHOLDER (app.ts): it fills in the public URL when it serves the page. */
const URL_PLACEHOLDER = "__ABTUNE_URL__";

const EMPTY_ROOT = '<div id="root"></div>';

/**
 * Fills the built index.html's empty #root with the start screen, rendered by React at build time,
 * and adds the page's structured data. Search engines read the start screen without running the app,
 * and so do AI answer engines' crawlers, most of which run no script.
 */
export function abtunePrerender(clientRoot: string, questionsDir: string): Plugin {
  return {
    name: "abtune-prerender",
    apply: "build",
    transformIndexHtml: {
      order: "post",
      async handler(html, ctx) {
        if (!ctx.filename.endsWith("index.html")) return html;
        if (!html.includes(EMPTY_ROOT)) throw new Error(`index.html has no empty ${EMPTY_ROOT}`);
        const { bank } = await loadBankFromDisk(["*.yaml"], { cwd: questionsDir });
        if (!bank) throw new Error("the question bank didn't load");
        // A throwaway dev server, only to load the .tsx entry with Vite's transforms.
        const vite = await createServer({
          configFile: false,
          root: clientRoot,
          logLevel: "error",
          appType: "custom",
          server: { middlewareMode: true, hmr: false, ws: false },
          // Nothing to pre-bundle for one server-side load (and the scan can't see the bank).
          optimizeDeps: { noDiscovery: true, include: [] },
          plugins: [react()],
        });
        try {
          const page = await vite.ssrLoadModule("/prerender.tsx");
          // "<" escaped, so no text in the data can close the script element.
          const data = JSON.stringify(page.structuredData(URL_PLACEHOLDER)).replace(
            /</g,
            "\\u003c",
          );
          return {
            html: html.replace(EMPTY_ROOT, `<div id="root">${page.landingHtml(bank)}</div>`),
            tags: [
              {
                tag: "script",
                attrs: { type: "application/ld+json" },
                children: data,
                injectTo: "head",
              },
            ],
          };
        } finally {
          await vite.close();
        }
      },
    },
  };
}
