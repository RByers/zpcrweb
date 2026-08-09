import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
// Imported by path rather than through the package specifier: this file runs in the config
// loader, before any alias applies, and `@zpcrweb/core`'s exports point at a `dist/` that may
// not have been built. `fileKind.ts` has no imports of its own, so reaching straight into it
// costs nothing and keeps one list of openable extensions (see SUPPORTED_EXTENSIONS' comment).
import { matchesSupportedExtension } from "../../packages/core/src/fileKind";

// Resolve @zpcrweb/core to its TypeScript source rather than its built `dist/`, so editing
// the library hot-reloads here without a separate `tsup --watch`. The matching `paths` entry
// in tsconfig.json keeps tsc and the editor pointed at the same files — change both together.
const coreSrc = fileURLToPath(new URL("../../packages/core/src/index.ts", import.meta.url));

/** The repo's `samples/` directory — the one copy of these files. */
const samplesDir = fileURLToPath(new URL("../../samples", import.meta.url));
/** Where the built app serves them from, and the prefix `lib/samples.ts` builds its URLs on. */
const SAMPLES_ROUTE = "examples";
const VIRTUAL_ID = "virtual:samples";

interface SampleEntry {
  name: string;
  size: number;
  lastModified: number;
}

/**
 * Read `samples/` — every file in it the app could open, by the same name filter a granted disk
 * folder is listed through. The directory is read at build (or dev-server) time and never
 * enumerated in source, so adding a file to `samples/` and rebuilding is all it takes for the app
 * to offer it; the `.xml` decodings and the `.zip` export beside them are not formats the app
 * opens, so they are left out exactly as they would be in a folder on disk.
 */
function readSamples(): SampleEntry[] {
  if (!existsSync(samplesDir)) return []; // A checkout with no `samples/` — the folder is empty.
  return readdirSync(samplesDir, { withFileTypes: true })
    .filter((e) => e.isFile() && !e.name.startsWith(".") && matchesSupportedExtension(e.name))
    .map((e) => {
      const stat = statSync(join(samplesDir, e.name));
      return { name: e.name, size: stat.size, lastModified: Math.round(stat.mtimeMs) };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/**
 * The bundled sample files: a `virtual:samples` module listing them, and the bytes themselves
 * served at `/examples/<name>`.
 *
 * Both halves come from one directory read, so the listing can never name a file the app won't
 * serve. In a build each sample is emitted verbatim (no content hash) — the name in the URL is
 * the name the user sees in the samples folder and the name the file gets when they open it. In
 * dev the same paths are served straight off disk by a middleware, so there is one mechanism in
 * both modes and nothing to keep in sync — and the directory is watched, so adding or removing a
 * sample reloads the running app instead of waiting for a restart.
 *
 * This replaced a `public/examples/` directory holding a symlink per offered file, which could
 * only ever list what someone had remembered to link.
 */
function samples(): Plugin {
  return {
    name: "zpcrweb-samples",
    resolveId(id) {
      return id === VIRTUAL_ID ? `\0${VIRTUAL_ID}` : null;
    },
    load(id) {
      if (id !== `\0${VIRTUAL_ID}`) return null;
      return `export const SAMPLE_FILES = ${JSON.stringify(readSamples())};\n`;
    },
    configureServer(server) {
      // Adding a sample to `samples/` should show up in the running app the way editing a source
      // file does. Two things stand in the way: the directory sits outside the Vite root, so the
      // watcher does not cover it, and the listing is a virtual module Vite caches after its one
      // `load`. So watch the directory explicitly, and on a change that the listing would show,
      // drop the cached module and reload. (The bytes need no help — the middleware below reads
      // them off disk per request.)
      server.watcher.add(samplesDir);
      let listing = JSON.stringify(readSamples());
      const refresh = (path: string) => {
        if (dirname(path) !== samplesDir) return;
        const next = JSON.stringify(readSamples());
        if (next === listing) return;
        listing = next;
        const mod = server.moduleGraph.getModuleById(`\0${VIRTUAL_ID}`);
        if (mod) server.moduleGraph.invalidateModule(mod);
        server.ws.send({ type: "full-reload" });
      };
      for (const event of ["add", "unlink", "change"] as const) server.watcher.on(event, refresh);

      server.middlewares.use((req, res, next) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const prefix = `/${SAMPLES_ROUTE}/`;
        if (!url.pathname.startsWith(prefix)) return next();
        // Matched against the listing rather than joined onto the directory: only a file this
        // plugin actually offers can be read, so no `..` or symlink games reach the disk.
        const name = decodeURIComponent(url.pathname.slice(prefix.length));
        if (!readSamples().some((s) => s.name === name)) return next();
        res.setHeader("Content-Type", "application/octet-stream");
        res.end(readFileSync(join(samplesDir, name)));
      });
    },
    generateBundle() {
      for (const sample of readSamples()) {
        this.emitFile({
          type: "asset",
          fileName: `${SAMPLES_ROUTE}/${sample.name}`,
          source: readFileSync(join(samplesDir, sample.name)),
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), samples()],
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
