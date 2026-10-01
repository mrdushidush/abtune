import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { abtuneBank } from "./src/bank-plugin.ts";

export default defineConfig({
  root: "src/client",
  build: { outDir: "../../dist/client", emptyOutDir: true },
  plugins: [
    react(),
    tailwindcss(),
    abtuneBank(path.resolve(import.meta.dirname, "../../data/questions")),
  ],
  server: { proxy: { "/api": "http://127.0.0.1:8787" } },
});
