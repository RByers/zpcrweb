# `zpcrweb.json` — zpcrweb's own settings entry

Unlike every other document in this repo, this one describes a format we **write**, not one we
reverse-engineered. `zpcrweb.json` is an entry zpcrweb adds to a `.zpcr` archive to record the
analysis parameters a run is being read with.

Implemented by `packages/core/src/zpcrwebSettings.ts`; the web app's in-memory half lives in
`apps/web/src/state/analysisSettings.ts`, and the write-behind scheduling in
`apps/web/src/state/analysisPersist.ts`.

## 1. Why it exists

A qPCR run has no single objective answer. The Cq the app reports depends on the threshold, and
the threshold depends on parameters a user can change (`threshold.md` §5). Those parameters used
to live in the browser's IndexedDB, keyed by file. That meant:

- the interpretation of a run was invisible to anyone the file was sent to — same bytes, different
  numbers, nothing to explain the gap;
- opening the same file on a second machine, or after clearing site data, silently reverted to
  automatic thresholds while the run itself survived intact;
- and the browser and the file could disagree about the run with no way to tell which was right.

So the parameters go where the data is. A `.zpcr` is a plain ZIP (see `icff.md`'s sibling note in
`ARCHITECTURE.md`, and `packages/core/src/archive.ts`), so this is one more entry beside
`RunInfo.xml` and the `.Plateread` files. Bio-Rad's tooling ignores entries it doesn't recognize,
and `parseZpcr` only reads the ones it knows, so the addition is invisible to both.

**Display state does not go here.** Which wells are selected, which fluorophores are hidden, log
vs. linear — none of it changes a number, all of it is one person's view onto the run, and it
stays in IndexedDB (`apps/web/src/state/db.ts`).

## 2. Location and encoding

| | |
|---|---|
| Entry name | `zpcrweb.json`, at the archive root |
| Encoding | UTF-8 JSON, `JSON.stringify(…, null, 2)` plus a trailing newline |
| Compression | whatever `fflate`'s `zipSync` picks — a normal ZIP entry, no encryption |

Pretty-printed rather than minified on purpose: it is *our* format, so it should be readable to
anyone who runs `unzip -p run.zpcr zpcrweb.json`, and it should diff line by line. It costs a few
hundred bytes in a ~400 KB archive.

`.pcrd` files get **no** equivalent. A `.pcrd` is a single encrypted XML document, not an archive
(see `pcrd.md` §1), so there is nowhere to put an entry; it does carry its own per-fluorophore
analysis parameters (`dataAnalysisParameters`, `pcrd.md` §2.5), which we decode but do not yet
write back. Analysis edits to a `.pcrd` are therefore live for the session and then gone.

## 3. Schema

```json
{
  "version": 1,
  "generator": "zpcrweb",
  "updatedAt": "2026-07-26T14:03:11.284Z",
  "analysis": {
    "thresholdOverrides": { "FAM": 210, "Texas Red": 49 },
    "curveThresholdOverrides": { "3,2,Texas Red": 120 },
    "thresholdMultiplier": 20,
    "subtractDark": false,
    "calibrationNormalization": "global"
  }
}
```

| Field | Type | Meaning |
|---|---|---|
| `version` | number | Schema version. `1` today. |
| `generator` | string? | Free-form provenance for a human reading the raw entry. |
| `updatedAt` | string? | ISO-8601 timestamp of the last write. |
| `analysis` | object? | The parameters below. Absent means "this run has no opinion". |
| `analysis.thresholdOverrides` | `{ [fluor]: RFU }`? | Manual thresholds, keyed by **fluorophore**. Never by target — a threshold derives from baseline noise, a property of the dye and the optics, not of the biological label (`RunAnalysis.thresholdGroupOf`, `threshold.md` §5.1). Values must be > 0. |
| `analysis.curveThresholdOverrides` | `{ "row,col,fluor": RFU }`? | The same, one curve at a time — one well's one dye, keyed by the app's `curveKey` with 0-based row/column. Outranks `thresholdOverrides`, which outranks the automatic value (`threshold.md` §5.4). Values must be > 0. |
| `analysis.thresholdMultiplier` | number? | §5.1's `k` in `threshold = k × median baseline noise`, for every group with no override. Must be > 0. |
| `analysis.subtractDark` | boolean? | Subtract the LED-off `DARKDATA` before color separation (`calibration.md` §4.2). |
| `analysis.calibrationNormalization` | `"none" \| "column" \| "global"`? | Calibration matrix column normalization (`calibration.md` §3). Not exposed in the UI. |

The app writes all five `analysis` fields whenever the user has touched any of them, including
ones that equal the current default. The entry records *the parameters this run was analyzed
with*; a default that shifts in a later build must not silently re-analyze an old run.

## 4. Compatibility rules

**Reading is total and field-by-field.** `parseZpcrwebSettings` never throws. A document that
isn't a JSON object at all yields `null`; within one that is, every field is validated
independently and a missing, misspelled, mistyped or out-of-range one is dropped so the reader's
own default applies. A file written by a newer build degrades a field at a time rather than
failing whole, which is why `version` is informational — the field-level validation is what
actually protects the reader, and a higher `version` is honored as-is.

**Writing replaces the document.** Unknown keys are not round-tripped. The alternative makes the
entry a shared mutable namespace between versions, where an old build silently preserves state it
cannot honor and the two disagree about what the run means. Losing an unknown key is visible;
half-honoring one is not.

**The file wins.** When a `.zpcr` carries this entry it is the sole source of the run's analysis
state; the browser never overrides it from local storage. The one exception is a one-time
migration of records written before this entry existed, which applies only to a file that has no
`zpcrweb.json` of its own and is then written into it (see `legacyAnalysisFromStored`).

## 5. Write scheduling

Saving means re-zipping the archive and writing several hundred KB back to IndexedDB, and the
controls that produce these edits are a slider and a number field. So writes are **rate-limited,
not debounced**: an edit to an idle file is written immediately, and further edits within 60 s
coalesce into one trailing write at the end of the window. A continuously-dragged slider costs one
rewrite per minute, and the final position always lands because the trailing write reads current
state rather than a captured value. Pending writes are also flushed when the active file changes,
on `visibilitychange` → `hidden`, and on `pagehide`.

The rewritten bytes go to IndexedDB only — never back into React state, where they would re-parse
the run and rebuild every derived value on each save. The Overview view's download button calls
`ZpcrStore.exportBytes`, which re-zips on demand, so a downloaded copy always carries current
settings.

## 6. One reader, one writer

The consequence of §5 is that at any moment there are up to three versions of the document: the
one embedded in the bytes the session parsed, the one in the IndexedDB record (up to a minute
behind live state), and live React state. **Live state is authoritative for the whole lifetime of
a loaded file**, and the embedded copy is read exactly once:
`parseZpcrwebSettings` is called only from `useZpcrStore`'s seeding effect, guarded by a `seeded`
set, so a re-parse (password change, plate attach) can never resurrect the pre-edit document over
an edit made since.

That single-read rule is what makes the divergence harmless, and it is why a download does not
try to reconcile anything: it does not re-seed, swap the in-memory bytes, or reset the persister.
Making the export "commit" would mean re-parsing the run and rebuilding every derived value at
exactly the moment the user asked for a file — cost and risk in exchange for converging state
that the flush cycle converges anyway.

The remaining hazard is a *reader* — anything showing the user the embedded copy would show
settings nothing is being analyzed with. The Raw view's `zpcrweb.json` row therefore synthesizes
its content from live state via `formatZpcrwebSettings(zpcrwebFromAnalysis(settings))`, the same
serializer the writer uses, and lists the entry even for a file whose archive has none. It is
byte-identical to what a download would contain except for `updatedAt`, which is stamped at write
time.
