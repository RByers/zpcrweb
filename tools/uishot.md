# `uishot.mjs`

One-call headless-Chrome screenshot check for the web app: it boots its own dev server and Chrome
on random ports, loads a sample file, walks the requested views, and writes a **single labelled
contact-sheet PNG** plus a short text report of console and page errors.

The point is token economy. Every click, reload and wait happens inside the script, so an agent
pays for one command's output and one image rather than a round-trip per step. `AGENTS.md`'s "UI
testing" section says when to reach for it and how to keep it cheap; this file says how to drive
it.

## Usage

```sh
node tools/uishot.mjs                                        # overview+curves of the default sample
node tools/uishot.mjs --views curves --width 1100
node tools/uishot.mjs --file samples/foo.pcrd --views overview,plates,raw
node tools/uishot.mjs --url '/?foo=1' --views overview       # extra query params
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--views` | `overview,curves` | comma-separated views to capture |
| `--file` | `samples/20260720_FirstQualification.zpcr` | sample file to load |
| `--no-file` | — | capture without loading anything (welcome screen) |
| `--out` | `tools/.uishot/shot.png` | contact-sheet path |
| `--width` / `--height` | `1000` / `760` | viewport size per view |
| `--max-width` | `1400` | scale the finished sheet to at most this width |
| `--url` | `/` | path/query to open before the view walk |

Flags accept `--flag value` or `--flag=value`.

Valid views: `overview`, `protocol`, `curves`, `plates`, `reference`, `calibration`, `raw`,
`instrument`, `files`, `about`. An unknown view fails fast rather than silently capturing the
wrong thing.

## Reading the output

- **The text report is nearly free.** `console clean` versus a `PROBLEMS` list is often all you
  need; a run whose report is clean and whose diff is small may not need the image at all.
- **The image costs roughly w×h/750 tokens.** The 1400px default is legible for layout, spacing and
  chart rendering. `--max-width 900` is enough for a quick "is it broken" check; raise it only when
  judging fine typography.
- Progress goes to stderr with elapsed timings, so a stalled run shows where it stalled. The final
  report on stdout stays clean enough to read in one glance.

## How the sample gets loaded

Via CDP's `DOM.setFileInputFiles` against the app's own `<input type="file">` — zero tokens, and it
exercises the real `addFiles` → validate → IndexedDB path a user triggers by dropping a file.
`AGENTS.md` records the alternatives that were rejected (seeding IndexedDB directly, a `?sample=`
parameter, synthesized drag-and-drop) so they don't get re-proposed.

Each run starts from a clean Chrome profile, so a previous run's sample can't linger in IndexedDB
and show up as an extra file chip.

## Requirements

Node and the system Chrome — no Puppeteer, no extra dependencies. Set `CHROME_PATH` if Chrome
isn't at `/Applications/Google Chrome.app`. Chrome is always launched headless; see
[`harness.md`](./harness.md) for the flags and why they matter.
