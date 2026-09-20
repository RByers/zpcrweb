import { defineConfig } from "tsup";

export default defineConfig({
  // Two entries, two chunks: the emulator is a whole imitation instrument and the web app
  // lazily `import()`s it, so a build that never sets the mock flag never downloads it.
  entry: ["src/index.ts", "src/emulator.ts"],
  format: ["esm", "cjs"],
  dts: true,
  sourcemap: true,
  clean: true,
  outExtension({ format }) {
    return { js: format === "cjs" ? ".cjs" : ".js" };
  },
});
