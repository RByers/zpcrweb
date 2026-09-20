# `chartshot.mjs`

Renders one of the web app's Curves charts to a PNG, from Node, without the web app. Not a script
— it is the library behind [`zpcr.mjs`](./zpcr.md)'s `curves` and `melt` commands.

## Why it runs the chart instead of redrawing it

`zpcr.mjs curves` and `zpcr.mjs melt` need a picture that *is* the chart, not one that resembles
it. The renderers, `apps/web/src/lib/uplot/chart.ts` and `meltChart.ts`, are real modules with real
behavior — log floors, baseline projection, Cq markers placed off `correctedValues`; Tm markers
placed off the derivative's peak — and any second implementation of either is a second answer
waiting to disagree with the first.

So this runs the actual module: esbuild bundles the chosen builder plus uPlot into one
self-contained HTML page exposing `window.renderChart(config, host)`, headless Chrome opens it from
a `file://` URL, the caller's already-computed curves go in as JSON, and the rendered page comes
back out as a PNG. `renderChartPng(config, kind)` picks the builder — `"amplification"` (the
default) or `"melt"` — and hands it everything in `config` untouched.

What that buys: the picture cannot drift. A change to the chart's axes, colors, dashes or marker
placement reaches the CLI with no edit here at all. The bundle is rebuilt on every run (esbuild
takes ~50ms, noise beside Chrome's ~1s), so there is no stale artifact to mislead anyone.

What it costs: Chrome. Unlike `zpcr.mjs results`, `curves` and `melt` are not plain Node commands.

## Implementation notes

- Both charts' builders take a config whose only non-JSON member is `onHover`, and return
  `{ data, options }`. That shared shape is what lets one bundler, one page and one capture serve
  both; a third chart joins by adding a row to `CHARTS`.
- The bundle's entry point lives here as a **string**, not a file on disk: it is four lines of glue
  no one else has any use for, and a stray `.ts` file in `tools/` would look like something a
  reader could import. esbuild's `resolveDir` lets it import by the same relative paths a file at
  the repo root would.
- `@zpcrweb/core` resolves to the library's **source**, matching the alias `apps/web`'s
  `vite.config.ts` uses — so the bundle sees the same core the browser does and needs no built
  `dist/`.
- Package files are resolved with `createRequire` rather than by joining paths onto the repo root:
  in a git worktree the checkout has no `node_modules` of its own and resolution walks up to the
  main one, which a hand-built path would miss.

## Why not drive the whole app?

Booting a dev server, loading the file and clicking the well grid works — [`uitest.mjs`](./uitest.md)
does exactly that kind of thing — but it reaches the chart by way of everything around it, so the
CLI's `--wells`/`--fluors` would have to be re-expressed as clicks on a rail. Here the selection
stays where it already is: ordinary Node code over the run's analysis, handed to the renderer as
data.

## Requirements

Chrome (always headless — see [`harness.md`](./harness.md)), esbuild, and the web app's source.
