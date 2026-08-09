# tools/

Standalone scripts that sit outside the `packages/*`/`apps/*` workspaces — CLIs and
browser-automation helpers, run directly with `node` (or `python3` for the one exception), no
build step of their own. This is an index: one line per file, with a doc beside it for how to use
it, and the file's own header comment for anything below that.

| Tool | What it's for | How to use it |
|------|---------------|---------------|
| [`zpcr.mjs`](./zpcr.mjs) | Run analysis from the command line: a run's results table as CSV, its curves as a PNG of the app's own chart, or a new pending experiment written out as a `.zpcr`. | [`zpcr.md`](./zpcr.md) |
| [`cfx.mjs`](./cfx.mjs) | Talk to a live CFX96/C1000 over USB — identification, status, directory listing, file download. | [`cfx.md`](./cfx.md) |
| [`uishot.mjs`](./uishot.mjs) | One-call headless-Chrome screenshot check: walks the requested views and writes a single labelled contact sheet plus a console-error report. | [`uishot.md`](./uishot.md) |
| [`uitest.mjs`](./uitest.mjs) | Browser assertions (`npm run test:ui`) for what a no-DOM unit test and a no-interaction screenshot can't catch. | [`uitest.md`](./uitest.md) |
| [`harness.mjs`](./harness.mjs) | Shared library for `uishot.mjs` and `uitest.mjs`: the CDP client, the process plumbing, and the waiting vocabulary a check should be written in. | [`harness.md`](./harness.md) |
| [`chartshot.mjs`](./chartshot.mjs) | Shared library for `zpcr.mjs curves`: renders the web app's real chart module to a PNG from Node. | [`chartshot.md`](./chartshot.md) |
| [`usbpcap_decode.py`](./usbpcap_decode.py) | Decodes a USBPcap capture of CFX96 traffic, for validating `usb.md` against the real thing. | [`usbpcap_decode.md`](./usbpcap_decode.md) |

`zpcr.mjs` and `cfx.mjs` need a built core (`npm run build`); everything browser-driven needs
Chrome. `AGENTS.md`'s "UI testing" section says when an agent should reach for `uishot.mjs` and
`uitest.mjs`; the docs above say how to drive them.
