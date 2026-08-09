# `zpcr.mjs`

A command-line face on `@zpcrweb/core`'s run-analysis pipeline: read a run and print its results
or draw its curves, or write a new pending experiment for an instrument to run.

The point is that the answers match the app's. Every number comes from the same
`computeRunAnalysis`/`buildAnalysisRows`/`analysisCsv` the Curves view uses, and the `curves`
picture is drawn by the app's own chart module in headless Chrome ([`chartshot.md`](./chartshot.md)),
so neither the CSV nor the PNG is a second implementation that can drift.

## Usage

```sh
node tools/zpcr.mjs <run> results [--password <pw>] [--step <n>]
node tools/zpcr.mjs <run> curves  [--password <pw>] [--step <n>] [selection] [-o out.png]
                                  [--size WxH] [--dpr N]
node tools/zpcr.mjs <out.zpcr> new --name <name> --protocol <p.prcl.txt>
                                   [--plate <p.plt.csv>] [--force]
```

`<run>` is any of the three run formats — a CFX `.zpcr` or `.pcrd`, or a Biomeme `.bmrun` — routed
on extension the way the app routes a dropped file. `new` is the one command whose file argument is
*written* rather than read: it is always a `.zpcr`, and it must not already exist.

## `results`

Prints the run's results table as CSV on stdout — one row per loaded well/fluorophore pair, Cq and
all. This is the same table the web app's Curves view shows in Table mode and downloads as CSV.

## `curves`

Writes a PNG of the amplification curves as the Curves chart draws them in its default Relative
mode: same colors, same dark background, a ring at each Cq.

| Flag | Meaning |
|------|---------|
| `--wells A1,B2-D5` | plot these wells (ranges allowed) |
| `--rows A-C` | plot these plate rows |
| `--cols 1,5` | plot these plate columns |
| `--fluors FAM,HEX` | restrict to these fluorophores |
| `--channels` | plot raw channel curves instead of dye-space curves |
| `-o`, `--out` | output path (default `<run>-curves.png` beside the working directory) |
| `--size WxH` | chart size in **CSS** pixels (default `1100x620`) |
| `--dpr N` | device-pixel ratio, 1–4 (default 1) |

`--size` and `--dpr` compose the way a browser on a retina display does: `--size 640x360 --dpr 2`
is a 1280×720 file of the chart *laid out* at 640 wide, not the smaller-lettered chart that
`--size 1280x720` would lay out. An empty selection is an error rather than a blank rectangle — a
PNG on disk has no rail and no empty-state message to explain itself with.

## `new`

Writes a **pending experiment**: a `.zpcr` carrying a protocol, the run's name and optionally a
plate, with no plate reads and no `begun` marker. That is exactly what the app's "New experiment"
creates, so the file opens there as a run waiting to be started on an instrument. `--plate` may be
left out and attached later; `--force` overwrites an existing file, which the command otherwise
refuses to do. The archive is built by core's own `buildExperimentArchive`, then read back through
`parseZpcr` and summarized on stderr as a check that what landed on disk is a run.

## Passwords

`results` and `curves` take `--password` for CFX-encrypted data. Without it they fall back to
`cfxPassword` in the gitignored `secrets.json` at the repo root. A `.pcrd` needs the password
before parsing at all (its whole document sits inside an encrypted zip entry); a `.zpcr` only needs
it for plate data.

## Requirements

`results` and `new` are plain Node over a built core (`npm run build`). `curves` additionally needs
Chrome and the web app's source, because that is where the chart lives — `chartshot.mjs` is
imported lazily so the CSV path still works on a checkout that can render no chart at all.
