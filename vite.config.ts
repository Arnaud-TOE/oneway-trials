import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Dev-only sink for the risk-test page: the page POSTs its measurements here and
 * they are written to .spike/results.json (git-ignored). Never part of a build.
 */
function spikeResultSink(): Plugin {
  return {
    name: "spike-result-sink",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__spike-result", (req, res) => {
        if (req.method !== "POST") {
          res.statusCode = 405;
          res.end();
          return;
        }
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const dir = resolve(server.config.root, ".spike");
          mkdirSync(dir, { recursive: true });
          const asked = new URL(req.url ?? "", "http://x").searchParams.get("name") ?? "";
          const name = /^[a-z]{3,20}$/.test(asked) ? asked : "results";
          writeFileSync(resolve(dir, `${name}.json`), Buffer.concat(chunks));
          res.statusCode = 204;
          res.end();
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), spikeResultSink()],
  server: { port: 5173, strictPort: true },
  // Libraries loaded only when a document is opened. Listed here so the dev
  // server prepares them at start-up: otherwise it discovers them on first use
  // and reloads the page, which threw away the first document opened.
  optimizeDeps: { include: ["pdfjs-dist", "tesseract.js"] },
});
