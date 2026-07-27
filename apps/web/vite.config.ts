import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Resolve @zpcrweb/core to its TypeScript source rather than its built `dist/`, so editing
// the library hot-reloads here without a separate `tsup --watch`. The matching `paths` entry
// in tsconfig.json keeps tsc and the editor pointed at the same files — change both together.
const coreSrc = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));

export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
  resolve: {
    alias: {
      "@zpcrweb/core": coreSrc,
      react: "preact/compat",
      "react-dom/test-utils": "preact/test-utils",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
});
