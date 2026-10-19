import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { casesPlugin } from "./server/casesPlugin";

const appDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appDir, "..");

export default defineConfig({
  plugins: [react(), casesPlugin(repoRoot)],
  server: { port: 5173, strictPort: false },
  optimizeDeps: { include: ["pdfjs-dist"] },
});
