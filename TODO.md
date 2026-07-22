# TODO / Roadmap

Deferred work, captured so we can come back to it. The long-term goal is a **full
visualizer for everything** inside a `.zpcr` archive.

## Library (`@zpcrweb/core`)

Additional typed parsers for the archive files currently reachable only via the low-level
`archive` API (raw bytes / text / hex):

- [ ] **Protocol** — `ProtocolName.txt`, `ProtocolRunDefinition.txt`
      (e.g. `METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP …;PLATEREAD;GOTO 2,44;END`). Parse
      into structured steps + cycling program.
- [ ] **`.alf` run log** — the `*_…_Luna_noRT.alf` tab/`*`-delimited step-by-step run log
      (per-step temperatures, timestamps, elapsed time, error state).
- [ ] **`runlog.xml`** — full structured run event log.
- [ ] **`.Dcal` dye calibration files** — one per dye/plate-type (FAM, HEX, VIC/Cal Gold
      540, ROX/Tex 615/Cal Orange 560, Cy5, Quasar 670/705, …). Needed for the
      **channel → dye mapping**, which the `.Plateread` payload alone cannot provide.
- [ ] **Plateread header** — pin down the remaining approximate byte offsets from
      `plateread.md` §3 (ambient/shuttle/lid temps, LED currents ×6, fan/lid state) and the
      trailing descriptor dictionary (§4). Promote from best-effort to fully typed.
- [ ] **`FactoryRefRowCal`** — parse the factory reference-row calibration array in
      `RunInfo.xml` into typed per-well records.
- [ ] Optional: baseline subtraction / Cq (Ct) calculation helpers derived from the curves.

## Web app (`apps/web`)

React + Vite + uPlot app shipped (v1). Done:

- [x] Vite app depending on `@zpcrweb/core`.
- [x] Drag-and-drop + click file upload; multiple files; switch between them.
- [x] IndexedDB persistence of files + per-file view settings; delete from storage.
- [x] Run overview (metadata, protocol, cycle count, block/serial info).
- [x] Amplification-curve chart (per channel, per well; channel bar + 8×12 well matrix with
      row/column toggles; Raw ↔ ΔRFU; Linear ↔ Log; hover tooltip with mean/min/max/std).
- [x] **Raw file browser** over the archive API — hex/ASCII + text viewer for every entry.
- [x] Responsive (container queries) from large desktop down to mobile.

- [x] Reference row (R) in the well matrix (off by default, dashed).
- [x] Dark (LED-off) background: dashed per-channel lines, or subtract from curves.
- [x] Decoded Raw-files views: plateread tables, RunInfo key/value table, protocol steps,
      pretty-printed + highlighted runlog.xml. Per-file default mode (decoded/text/hex).

Still planned:

- [ ] Plate heatmap per cycle.
- [ ] Full visualizers replacing the raw viewers as typed parsers land above (`.alf`,
      `.Dcal`, and the remaining plaintext status files).
- [ ] Confirm channel → dye mapping from the `.Dcal` calibration files (currently a hint;
      C6 = FRET is an inference).
- [ ] Decode `FactoryRefRowCal` / reference-well calibration into typed per-well records.

## Testing / infra

- [ ] Add a browser-mode Vitest run to prove isomorphism in a real browser environment.
- [ ] Add Playwright e2e tests for the web app (only if UI bugs prove frequent — per the
      logic-in-library principle, app logic is minimal and the library carries the tests).
- [ ] Add more sample `.zpcr` files (different block types, channel counts, cycle counts)
      as they become available.
- [ ] CI workflow (install / typecheck / test / build).
