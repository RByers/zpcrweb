# TODO / Roadmap

Deferred work, captured so we can come back to it. The long-term goal is a **full
visualizer for everything** inside a `.zpcr` archive.

## Library (`@zpcrweb/core`)

Additional typed parsers for the archive files currently reachable only via the low-level
`archive` API (raw bytes / text / hex):

- [ ] baseline subtraction / Cq (Ct) calculation helpers derived from the curves.
      **Algorithms and the full option space are now specified in
      [`threshold.md`](./threshold.md)** — smoothing, baseline region selection (auto and
      manual), baseline subtraction modes, auto/override threshold, and the two Cq algorithms.
      Implementation is the remaining work; §8 there lists the defaults to start from.
- [ ] **Protocol** — `ProtocolName.txt`, `ProtocolRunDefinition.txt`
      (e.g. `METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP …;PLATEREAD;GOTO 2,44;END`). Parse
      into structured steps + cycling program.
- [ ] **`.alf` run log** — the `*_…_Luna_noRT.alf` tab/`*`-delimited step-by-step run log
      (per-step temperatures, timestamps, elapsed time, error state).
- [ ] **`runlog.xml`** — full structured run event log.
- [ ] **Plateread header** — LED currents ×6 and fan/lid state are decoded via the
      descriptor dictionary but only reachable through `decodePlateReadDetail`; promote them
      to the typed `PlateRead` surface like the temperatures now are.
- [ ] **`FactoryRefRowCal`** — parse the factory reference-row calibration array in
      `RunInfo.xml` into typed per-well records.

## Web app (`apps/web`)

Still planned:

- [ ] When a file is opened with an attached plate (pcrd or zpcr with embedded pltd), use the plate definition to determine the UI defaults (channels and wells to display etc.).
- [ ] Add a plate editor which allows setting the flourophores used per well, as well as the tube types for the plate (clear / white).  Used for calibration adjustments and fluorophore display. Allow saving/naming plate files and applying them to runs. Remember the plate setting applied to each loaded run. Have an easy mechanism to copy/paste settings from one well to another or to all wells on a column/row/plate, or to duplicate a column/row across multiple columns/rows (eg. using click drag to select a region simple to copy/paste operations in spreadsheets)
- [ ] Optionally allow writing the target and sample names per well in the plate editor, again with easy copy paste of some form. Then use these in the curves visualization (eg. on hover).
- [ ] Add an option to apply flourophore-specific calibration to the run based on the calibration file data.
- [ ] Plate heatmap per cycle. 
- [ ] Full visualizers replacing the raw viewers as typed parsers land above (`.alf`,
      `.Dcal`, and the remaining plaintext status files).

## Testing / infra

- [ ] Add a browser-mode Vitest run to prove isomorphism in a real browser environment.
- [x] ~~Add Playwright e2e tests for the web app~~ — done without Playwright: `tools/uitest.mjs`
      (`npm run test:ui`) drives headless Chrome over CDP with no dependencies. 15 assertions,
      ~9s. Scoped to the two URL contracts that regress silently (hash routing, password
      handling); the logic-in-library principle still holds for everything else.
- [ ] Add more sample `.zpcr` files (different block types, channel counts, cycle counts)
      as they become available.
- [ ] CI workflow (install / typecheck / test / build).

### UI tooling follow-ups

- [ ] **Confirm the dev-server shutdown race.** `tools/harness.mjs`'s `killGroup()` signals the
      whole process group and Chrome reliably reaps to zero, but a `ps` taken immediately after
      `uishot`/`uitest` exits sometimes still shows 1–2 `vite` processes; a moment later they
      are gone. Looks like normal async teardown rather than a leak — confirm with a short
      poll, and if it is real, have `stop()` await process exit. Symptom to watch for: a stale
      `--strictPort` collision on a rerun.
- [ ] **Widen `uitest.mjs` coverage.** Natural next checks: a standalone `.pltd`/`.plt.csv`
      exposing only the Plates + Raw tabs, multi-file switching through `FileBar` (including
      that per-file settings don't bleed across files), and the `.pcrd` password prompt
      appearing when no password is available.
- [ ] **Decide whether `test:ui` runs in CI.** It is deliberately outside `npm test` (needs
      Chrome, ~9s vs ~3s) and `process.exit(1)`s without a `secrets.json` password. To gate CI,
      split the routing checks (no secret needed) from the password checks (secret required).
- [ ] **Root `ARCHITECTURE.md` doesn't mention `tools/`.** CLAUDE.md and
      `apps/web/ARCHITECTURE.md` cover the harness; a short "Tooling" section would close the
      loop.
- [ ] **`#file=` matches on name only.** Two loaded files sharing a name (different sizes, so
      distinct `fileId()`s) are indistinguishable in the URL — first match wins. Rare enough to
      ignore; a short id prefix could break the tie if it ever matters.
- [ ] **Hash state is view + file only.** Selected wells/channels/fluorophores stay per-file in
      IndexedDB. `state/urlHash.ts` was built to extend (more keys in the same query string) if
      sharing a specific chart view becomes useful.
