# TODO / Roadmap

Deferred work, captured so we can come back to it. The long-term goal is a **full
visualizer for everything** inside a `.zpcr` archive.

## Immediately next

- [ ] It seems common for a negative curve to grow in the first 5 cycles then level off flat. It seems like we should be picking the large later flat line as the baseline but we often pick the start instead. See 20230829's well F5 and 20260726 D4 FAM.
- [ ] Add a 'Calibration' tab which provides a nice vizualization of all calibration files, on a chart. By default only the ones in use in the analysis should be shown, but others can be enabled manually (similar to how fluorophores work in the chart view). Also provide a channel selector which can be enabled and disabled just like in curves view (share as much code/CSS as is reasonable). The chart should have temperature on the X axis and RFU on the Y axis, interpolating exactly as our algorithm does (if linear then that's trivial - don't draw extra points).
- [ ] Enable sorting on the table view. Click to sort by Cq or well.
- [ ] Review all indexedb storage beyond the data files. Remove anything which effects the analysis (like threshold overrides) - that should come strictly from the file. Whenever such state exists, add a new entry to the zpcr file, call it "zpcrweb.json". In order to make storing this efficient, use a debounce system and pagehide handler - eg. only recreate the zip file in the indexeddb from the in-memory state at most once a minute and on pagehide. When a zpcr file is loaded, read these settings from it (if any) to initialize state. Consider whether we can remove everything from indexeddb other than the files now - what would we lose, and is it just transient state which could be stored in the URL (like the active view mode)?

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
- [ ] **Plateread header** — fan/lid state is decoded via the descriptor dictionary but only
      reachable through `decodePlateReadDetail`; promote it to the typed `PlateRead` surface like
      the temperatures and LED currents now are.
- [ ] **`FactoryRefRowCal`** — parse the factory reference-row calibration array in
      `RunInfo.xml` into typed per-well records.

## Web app (`apps/web`)

- [ ] Add a plate editor which allows setting the flourophores used per well, as well as the tube types for the plate (clear / white).  Used for calibration adjustments and fluorophore display. Allow saving/naming plate files and applying them to runs. Remember the plate setting applied to each loaded run. Have an easy mechanism to copy/paste settings from one well to another or to all wells on a column/row/plate, or to duplicate a column/row across multiple columns/rows (eg. using click drag to select a region simple to copy/paste operations in spreadsheets)
- [ ] Optionally allow writing the target and sample names per well in the plate editor, again with easy copy paste of some form. Then use these in the curves visualization (eg. on hover).
- [ ] Add an option to apply flourophore-specific calibration to the run based on the calibration file data.
- [ ] Plate heatmap per cycle. 
- [ ] Full visualizers replacing the raw viewers as typed parsers land above (`.alf`,
      `.Dcal`, and the remaining plaintext status files).

## Testing / infra

- [ ] Add a browser-mode Vitest run to prove isomorphism in a real browser environment.
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
- [ ] **Hash state is view + file only.** Selected wells/channels/fluorophores stay per-file in
      IndexedDB. `state/urlHash.ts` was built to extend (more keys in the same query string) if
      sharing a specific chart view becomes useful.

## Cleanups

Simplification / dead-code removal, from a whole-project review (2026-07-27). Items marked
**needs input** are judgment calls left for the repo owner rather than mechanical wins.

### `@zpcrweb/core`

- [ ] **Un-export four module-private symbols.** `symmetricEigenDecomposition` (`linalg.ts`),
      `byChannel` (`pltd.ts`), `parseAttrs` (`xmlLite.ts`) and `ZIPCRYPTO_HEADER_LEN`
      (`zipcrypto.ts`) are each used only inside their own file and are not re-exported from
      `index.ts`. Dropping `export` narrows the module surface with no behavior change.
- [ ] **`pltd.ts`: a doc comment sits on the wrong function.** The block describing
      `parsePlatesetup2` is attached to `byChannel`, which was inserted between the function
      and its comment; `parsePlatesetup2` is left undocumented.
- [ ] **`refCalComparison()` recomputes `parseFactoryRefRowCal`.** Both `zpcr.ts` and `pcrd.ts`
      call it with the arguments `factoryRefCal()` already used. Reuse the existing result
      (preserving laziness).
- [ ] **needs input — the ZipCrypto test-encryption helper exists three times.**
      `test/pcrd.test.ts`, `test/pcrd-synthetic.test.ts` and `test/prcl.test.ts` each carry an
      identical ~120-line copy of `CRC_TABLE`/`crc32`/`EncryptKeys`/`zipCryptoEncrypt` and the
      synthetic-archive builders — ~240 lines of duplication. A shared `test/zipCrypto.ts`
      (alongside the existing `test/sample.ts`, `test/secrets.ts`) would collapse it. A comment
      in `pcrd.test.ts` records that self-contained duplication was a deliberate earlier call,
      so this is a revisit-the-decision question, not an oversight.

### Repo hygiene

- [ ] **Stale worktrees.** `.claude/worktrees/` holds four locked worktrees, two of which
      (`bridge-cse_012…`, `bridge-cse_014…`) have no commits beyond `main` and are pure
      leftovers. Prune once no job is using them.

### Knip false positives — do not "clean up"

Recorded so a future pass doesn't remove them: `ProtocolStep` (`prcl.ts` → `types.ts` →
`index.ts`) is public API consumed by `apps/web`; `Cdp` and `drainProblems`
(`tools/harness.mjs`) are imported by `tools/uishot.mjs`. Knip misses both cross-package and
`.mjs` script-to-script imports.
