import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";
import { abtuneBank } from "./src/bank-plugin.ts";

const client = path.resolve(import.meta.dirname, "src/client");

/** The legal pages at the clean addresses the server gives them (/privacy, /terms). */
const legalPages = (): Plugin => ({
  name: "abtune-legal-pages",
  configureServer(server) {
    server.middlewares.use((req, _res, next) => {
      if (req.url === "/privacy" || req.url === "/terms") req.url = `${req.url}.html`;
      next();
    });
  },
});

export default defineConfig({
  root: "src/client",
  build: {
    outDir: "../../dist/client",
    emptyOutDir: true,
    // The app, and the privacy and terms pages: static documents that need no script.
    rollupOptions: {
      input: {
        index: path.join(client, "index.html"),
        privacy: path.join(client, "privacy.html"),
        terms: path.join(client, "terms.html"),
      },
    },
  },
  plugins: [
    react(),
    tailwindcss(),
    abtuneBank(path.resolve(import.meta.dirname, "../../data/questions")),
    legalPages(),
  ],
  server: {
    proxy: {
      "/api": "http://127.0.0.1:8787",
      // The short links (/x, /ig, /tt, in any case), which the server redirects.
      "^/([xX]|[iI][gG]|[tT][tT])/?(\\?.*)?$": "http://127.0.0.1:8787",
    },
  },
});
