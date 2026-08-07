/**
 * Render the web app's Curves chart to a PNG, from Node, without the web app.
 *
 * `zpcr.mjs curves` needs a picture that *is* the chart, not one that resembles it. The renderer
 * is `apps/web/src/lib/uplot/chart.ts` — a real module with real behaviour (log floors, baseline
 * projection, Cq markers placed off `correctedValues`), and any second implementation of it is a
 * second answer waiting to disagree with the first. So this runs the actual module: esbuild
 * bundles `buildChart` plus uPlot into one self-contained HTML page, headless Chrome opens it
 * from a `file://` URL, the caller's already-computed curves go in as JSON, and the rendered
 * page comes back out as a PNG.
 *
 * What that buys, over drawing the chart a second time in Node: the picture cannot drift. A
 * change to the chart's axes, colors, dashes or marker placement reaches the CLI with no edit
 * here at all — and the bundle is rebuilt on every run (esbuild takes ~50ms, noise beside
 * Chrome's ~1s), so there is no stale artifact to mislead anyone.
 *
 * What it costs: Chrome. Unlike `results`, `curves` is not a plain Node command — see
 * `AGENTS.md`'s UI-testing section for the flags that matter and why headless is not optional
 * here.
 *
 * Why not drive the whole app instead (dev server, load the file, click the well grid)? That
 * works — `uitest.mjs` does exactly that kind of thing — but it reaches the chart by way of
 * everything around it, so the CLI's `--wells`/`--fluors` would have to be re-expressed as
 * clicks on a rail. Here the selection stays where it already is: ordinary Node code over the
 * run's analysis, handed to the renderer as data.
 */

import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";
import { REPO, openPage, startChrome } from "./harness.mjs";

/** Resolve a package file the way Node would from here, rather than by joining a path onto
 * {@link REPO}: in a git worktree the checkout has no `node_modules` of its own and resolution
 * walks up to the main one, which a hand-built path would miss. */
const require = createRequire(import.meta.url);

/**
 * Bundle `buildChart` and uPlot into one IIFE exposing `window.renderChart(config, host)`.
 *
 * The entry lives here as a string rather than as a file on disk: it is four lines of glue no
 * one else has any use for, and a stray `.ts` file in `tools/` would look like something a
 * reader could import. `resolveDir` is what lets it import by the same relative path a file
 * sitting at the repo root would.
 *
 * `@zpcrweb/core` resolves to the library's **source**, matching the alias `apps/web`'s
 * `vite.config.ts` uses — so the bundle sees the same core the browser does, and needs no built
 * `dist/` (see "Why the web app imports core's source" in `ARCHITECTURE.md`).
 */
async function bundleChart() {
  const result = await build({
    stdin: {
      contents: `
        import uPlot from "uplot";
        import { buildChart } from "./apps/web/src/lib/uplot/chart";
        window.renderChart = (config, host) => {
          const { data, options } = buildChart({ ...config, onHover: () => {} });
          return new uPlot(options, data, host);
        };
      `,
      resolveDir: REPO,
      loader: "ts",
    },
    bundle: true,
    format: "iife",
    platform: "browser",
    alias: { "@zpcrweb/core": join(REPO, "packages/core/src/index.ts") },
    // Core's entry re-exports `node.ts`, whose `node:fs/promises` sits behind a dynamic import
    // precisely so browser consumers never load it (see the module's own note). Marking it
    // external leaves that import unresolved in a bundle that never reaches it — the same thing
    // Vite does for the app.
    external: ["node:fs/promises"],
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0].text;
}

/**
 * The page: one host element of exactly the requested size on the app's panel color, and a
 * script that renders into it and then flags itself ready.
 *
 * The chart's own colors come from `buildChart`, never from here — the only styling this page
 * adds is what the app provides *around* the chart: uPlot's own stylesheet (which positions the
 * canvas and axis layers; the app has no `.u-*` overrides to carry across) and the surface the
 * chart sits on.
 */
function pageHtml(bundle, css, config) {
  return `<!doctype html>
<meta charset="utf-8">
<style>
${css}
html, body { margin: 0; padding: 0; background: #0b0e14; }
#host { width: ${config.width}px; height: ${config.height}px; }
</style>
<div id="host"></div>
<script>${bundle}</script>
<script>
  window.__chartError = null;
  try {
    window.renderChart(${JSON.stringify(config)}, document.getElementById("host"));
  } catch (e) {
    window.__chartError = String((e && e.stack) || e);
  }
  window.__chartReady = true;
</script>
`;
}

/**
 * Render one chart and return the PNG bytes.
 *
 * `config` is a `BuildChartConfig` minus its `onHover` — `wellCurves` and the display mode,
 * exactly as the web app passes them, plus `width`/`height`. Everything in it must survive
 * `JSON.stringify`, which the run's analysis records already do: plain numbers and arrays.
 */
export async function renderChartPng(config) {
  const bundle = await bundleChart();
  const css = readFileSync(require.resolve("uplot/dist/uPlot.min.css"), "utf-8");
  const dir = mkdtempSync(join(tmpdir(), "zpcr-chartshot-"));
  const page = join(dir, "chart.html");
  writeFileSync(page, pageHtml(bundle, css, config));

  const chrome = await startChrome(join(dir, "chrome"), {
    width: config.width,
    height: config.height,
  });
  try {
    const cdp = await openPage(chrome.base, `file://${page}`, {
      domains: ["Page", "Runtime", "DOM"],
    });
    await cdp.send("Emulation.setDeviceMetricsOverride", {
      width: config.width,
      height: config.height,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await cdp.eval(
      "new Promise(r => { const t = () => (window.__chartReady ? r(1) : requestAnimationFrame(t)); t(); })",
      { awaitPromise: true },
    );
    const error = await cdp.eval("window.__chartError");
    if (error) throw new Error(`chart failed to render:\n${error}`);
    // Two frames, so the SVG overlay the chart draws from uPlot's `draw` hook (bands, Cq rings,
    // baseline ticks) is on screen and not merely scheduled.
    await cdp.eval("new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)))", {
      awaitPromise: true,
    });
    const { data } = await cdp.send("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: false,
    });
    return Buffer.from(data, "base64");
  } finally {
    chrome.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}
