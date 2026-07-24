# TODO / Roadmap

Deferred work, captured so we can come back to it. The long-term goal is a **full
visualizer for everything** inside a `.zpcr` archive.

## Library (`@zpcrweb/core`)

Additional typed parsers for the archive files currently reachable only via the low-level
`archive` API (raw bytes / text / hex):

- [ ] Parse the calibration files and try to infer how to use them. Do they include cross-talk information for subtracting a fraction of one channel from another? Search the web for any academic literature on how crosstalk elimination is done in practice. 
- [ ] baseline subtraction / Cq (Ct) calculation helpers derived from the curves.
- [ ] **Protocol** — `ProtocolName.txt`, `ProtocolRunDefinition.txt`
      (e.g. `METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP …;PLATEREAD;GOTO 2,44;END`). Parse
      into structured steps + cycling program.
- [ ] **`.alf` run log** — the `*_…_Luna_noRT.alf` tab/`*`-delimited step-by-step run log
      (per-step temperatures, timestamps, elapsed time, error state).
- [ ] **`runlog.xml`** — full structured run event log.
- [ ] **`.Dcal` dye calibration files** — one per dye/plate-type (FAM, HEX, VIC/Cal Gold
      540, ROX/Tex 615/Cal Orange 560, Cy5, Quasar 670/705, …). Needed for the
      **channel → dye mapping**, which the `.Plateread` payload alone cannot provide.
- [ ] **Plateread header** — LED currents ×6 and fan/lid state are decoded via the
      descriptor dictionary but only reachable through `decodePlateReadDetail`; promote them
      to the typed `PlateRead` surface like the temperatures now are.
- [ ] **`FactoryRefRowCal`** — parse the factory reference-row calibration array in
      `RunInfo.xml` into typed per-well records.
- [ ] Parse the .pltd file and try to decode how they define plates (flourophores, targets and samples per well).
- [ ] Parse the .prcl file and try to decode how it defines a protocol. Does it map exactly to the textual definition in ProtocolRunDefinition.txt?

## Web app (`apps/web`)

Still planned:

- [ ] Generate a nice simple but clear favicon
- [ ] Visualize calibration files
- [ ] Add a plate editor which allows setting the flourophores used per well, as well as the tube types for the plate (clear / white).  Used for calibration adjustments and fluorophore display. Allow saving/naming plate files and applying them to runs. Remember the plate setting applied to each loaded run. Have an easy mechanism to copy/paste settings from one well to another or to all wells on a column/row/plate, or to duplicate a column/row across multiple columns/rows (eg. using click drag to select a region simple to copy/paste operations in spreadsheets)
- [ ] Optionally allow writing the target and sample names per well in the plate editor, again with easy copy paste of some form. Then use these in the curves visualization (eg. on hover).
- [ ] Add an option to apply flourophore-specific calibration to the run based on the calibration file data.
- [ ] Plate heatmap per cycle. 
- [ ] Full visualizers replacing the raw viewers as typed parsers land above (`.alf`,
      `.Dcal`, and the remaining plaintext status files).

## Testing / infra

- [ ] Add a browser-mode Vitest run to prove isomorphism in a real browser environment.
- [ ] Add Playwright e2e tests for the web app (only if UI bugs prove frequent — per the
      logic-in-library principle, app logic is minimal and the library carries the tests).
- [ ] Add more sample `.zpcr` files (different block types, channel counts, cycle counts)
      as they become available.
- [ ] CI workflow (install / typecheck / test / build).
