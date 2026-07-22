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

Currently an empty scaffold. Planned:

- [ ] Vite app depending on `@zpcrweb/core`.
- [ ] Drag-and-drop / file-upload of a `.zpcr`.
- [ ] Run overview (metadata, protocol, cycle count, block/serial info).
- [ ] Amplification-curve chart (per channel, per well; well selector / plate view).
- [ ] Plate heatmap per cycle.
- [ ] **Raw file browser** using the low-level archive API — list every entry with a
      text / hex viewer, so unparsed files are still inspectable.
- [ ] Full visualizers replacing the raw viewers as typed parsers land above.

## Testing / infra

- [ ] Add a browser-mode Vitest run to prove isomorphism in a real browser environment.
- [ ] Add more sample `.zpcr` files (different block types, channel counts, cycle counts)
      as they become available.
- [ ] CI workflow (install / typecheck / test / build).
