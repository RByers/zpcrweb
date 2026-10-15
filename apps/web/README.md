# @zpcrweb/web

Web app for exploring Bio-Rad CFX qPCR runs, built on [`@zpcrweb/core`](../../packages/core).

**Status:** live at [zpcr.rbyers.ca](https://zpcr.rbyers.ca/). It runs entirely in the browser,
and nothing you open is uploaded anywhere. It opens `.zpcr`, `.pcrd` and Biomeme `.bmrun` runs,
standalone plates (`.pltd`, `.plt.csv`), thermal protocols (`.prcl`, `.prcl.txt`) and `.alf` run
reports. It shows them through the Overview, Protocol, Curves (amplification and melt), Plates,
Reference, Calibration and Raw views, and lets you edit plates and protocols. It can also work
in a folder on your disk, read files out of a GitHub repository, and drive a CFX96 live over
WebUSB from the Instrument view (`#mock` in the URL gives you a simulated instrument instead).
It is still far from a full replacement for CFX Maestro. Open work is tracked in the root
[`TODO.md`](../../TODO.md).

- What the app does, how to use it, browser support and its URL-hash keys:
  [the root README's `@zpcrweb/web` section](../../README.md#zpcrwebweb).
- How it is built: [`ARCHITECTURE.md`](./ARCHITECTURE.md).

```sh
npm run dev -w @zpcrweb/web        # dev server → http://localhost:5173
npm run build -w @zpcrweb/web      # production build (typechecks first)
npm run typecheck -w @zpcrweb/web  # typecheck only
npm run test:ui                    # browser checks (from the repo root; needs Chrome, ~100s)
```
