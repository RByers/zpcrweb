# `.plt.csv` — zpcrweb's own plate format

Like `zpcrweb.json` (see `zpcrweb-json.md`), this describes a format we **write**, not one we
reverse-engineered. There is no real (encrypted) `.pltd` *writer* — not worth building for a
format the app only ever needs to read (`pltd.md`) — so `plateCsv.ts` defines a small
zpcrweb-only plain-text plate format instead: a plate that can be authored, edited, or attached
to a run without needing a real `.pltd` file.

Implemented by `packages/core/src/plateCsv.ts`, entry points `plateToCsv`/`parsePlateCsv`; a name
matches the format iff `isPlateCsvName` accepts it (canonical extension **`.plt.csv`**, chosen to
stay distinguishable from the app's other CSV exports inside a `.zpcr` archive or on disk). A
`.plt.csv` archive entry is read by `zpcr.ts`'s `plates()` exactly like a `.pltd` one (wrapped in
a synthetic `Pltd`-shaped result, `pltdFromPlateCsv`), and `attachPlate.ts` writes one into an
archive, replacing any existing `.pltd`/`.plt.csv` entry.

## 1. Layout

A handful of `# key: value` header comment lines (plate-level metadata), then a standard CSV
table with one row per well:

```csv
# zpcrweb plate definition
# vessel: BR Clear 8x12
Well,SampleType,Sample,FAM,Tex 615
A1,unknown,S183,ATP,+
B1,ntc,,ATP,
```

RFC4180-ish: quoted fields, `""` escaping, CRLF or LF row endings both accepted (written as CRLF).
Header values are read up to the first comma, so a file round-tripped through a spreadsheet —
which pads every comment line out to the table's column count with trailing commas — still
parses.

## 2. Header lines

| Line | Meaning |
|---|---|
| `# vessel: <name> <rows>x<columns>` | The only header line that matters. `<name>` is `PlateDefinition.plateName` — the consumable type (`BR Clear`, `BR White`), not the plate's own name (see §4) — spelled `vessel` so it can't be mistaken for that. Either half may be left out: `<rows>x<columns>` is the plate's extent, and absent it the extent is inferred from the well labels seen in the table; the `<name>` is absent exactly when the plate states its vessel per well instead (§3.1). |
| `# plateType: <value>` | Display-only passenger from a `.pltd` (CFX's template category). Omitted when empty. |
| `# scanMode: <value>` | Display-only passenger from a `.pltd`. Omitted when empty. |
| `# standardUnits: <value>` | Display-only passenger from a `.pltd`. Omitted when empty. |

## 3. Table columns

| Column | Required? | Meaning |
|---|---|---|
| `Well` | yes | Well label (`A1`, `H12`, …). |
| `SampleType` | yes | A normalized type name (`unknown`, `standard`, `ntc`, `nrt`, `positiveControl`, `negativeControl`, `empty`, `passiveRef`, `custom`) — **or** a raw CFX `wellSampleType` code (`wcNTC`, …), accepted and normalized on read. An unrecognized type writes as its preserved raw code rather than inventing a `wcOther` no CFX tool emits. Blank cell = `empty`. |
| `Sample` | yes | Sample name. Blank = none. |
| `Replicate` | no | Written only when some well on the plate uses it (most don't — a column of empty cells says nothing); read whenever present, in any column position. |
| `Quantity` | no | Same rule as `Replicate`. |
| `Vessel` | no | This well's consumable type, for a plate loaded with a mix of plastics — see §3.1. Same rule as `Replicate`: written only when some well uses it. |
| one column per fluorophore | no | See §4. |

Row order is presentation only: `parsePlateCsv` places each row by its own well label and derives
the plate's target/sample lists by walking the wells, so a file re-sorted in a spreadsheet, or
with rows in any order at all, reads back identically. `plateToCsv` writes column-major (`A1, B1,
C1, … A2, B2`), the order a plate is actually filled down. A well carrying nothing at all (see
`isBlankWell`) is left out of the table entirely — on a typical plate that's most of the wells —
and a well missing from the table parses back to exactly that; the header's `rows`/`columns` (or
the well labels seen) keep the plate's extent regardless.

### 3.1 `Vessel` — a plate that mixes plastics

**This is the one thing the format describes that no CFX format can.** A `.pltd`/`.pcrd` carries
the vessel once, on the root element ([`pltd.md`](./pltd.md) §2), so a CFX plate is single-vessel
by construction — while the block itself is perfectly happy holding white strip tubes beside clear
ones, and the two plastics have separate pure-dye calibrations
([`calibration.md`](./calibration.md) §3.1).

A `Vessel` column gives each well its own value, in the same vocabulary as the header line
(`BR Clear`, `BR White`, `MJ White`; matched case-insensitively, like every vessel comparison).
A blank cell means the well says nothing.

**The two forms are strictly either-or.** A file that names a vessel on the header line *and*
carries a `Vessel` column is **rejected** — not resolved in some precedence order:

```
Plate CSV: the vessel is stated twice — "# vessel: BR White 8x12" names one and a "Vessel"
column gives one per well. Use one or the other: drop the column, or reduce the header line to
the plate's extent alone ("# vessel: 8x12").
```

The two would drift apart the first time someone edited one and not the other, and no reading of
which the author meant is better than the other. So a per-well plate writes the extent alone on
the header line and leaves `PlateDefinition.plateName` empty:

```csv
# zpcrweb plate definition
# vessel: 8x12
Well,SampleType,Sample,Vessel,FAM,Tex 615
A1,unknown,S183,BR White,ATP,+
A2,unknown,S184,BR Clear,ATP,+
```

An empty `plateName` therefore means "ask the wells", never "unknown".

`samples/mixed-vessel-YouSeq-RVP.plt.csv` is the committed example: three columns of a commercial
4-dye respiratory panel in white strip tubes (its NTC, positive-control and patient-pool strips)
beside one column of the operator's own RVP multiplex in clear ones.

It also carries **two dyes on one optical channel** — the panel's ROX and the operator's Tex 615
are both channel 2 — in different wells, which is legal and which no CFX plate can express either
(a CFX dye layer *is* a channel position). No well holds both, because nothing could unmix that;
the analysis resolves each well's dye set separately, so the panel's wells are solved against ROX
and the operator's against Tex 615. See [`calibration.md`](./calibration.md) §3.2. Note that a well carrying
*only* a vessel is not a blank well (§3) — the plastic is in the block whether or not anything was
pipetted into it — so its row is written out and survives the round-trip.

> **Future:** the vocabulary is open-ended here, as it is in a `.pltd` — anything containing
> "white" resolves to the `BR White` calibration and everything else to `BR Clear`
> (`resolveTubeType`). A third genuinely-distinct plastic would need calibration data that no
> archive currently ships.

## 4. Fluor columns

Every column that isn't one of the fixed ones (§3) is a fluor column, and the heading is the **dye
name entire** (`FAM`, `Tex 615`) — there is no other syntax in it. These columns *are* the plate's
whole fluor list; there's no separate header line to keep in sync. They are written in ascending
channel order (unknown-channel dyes last), matching every fluor list elsewhere in the app and in
a parsed `.pltd` (`byChannel` in `pltd.ts`). Like row order, column order is presentation only:
`parsePlateCsv` keys each cell to its column heading and re-sorts, so a file whose columns are in
some other order still reads back the same plate.

Each cell holds only that well's **target** for that fluor:

| Cell | Meaning |
|---|---|
| empty | fluor absent from the well |
| `+` | fluor present, no target set |
| any other text | fluor present, this is the target |

### 4.1 No optical channel, on purpose

The file never states which channel a dye is read on. A channel is a fact about the
*instrument's* optics, not about the plate: the same plate run on a machine whose filters map the
dye elsewhere is still the same plate. Writing one into the file would let a stale claim travel
with a portable document and contradict the hardware that actually read it.

Nothing needs it to. A dye is displayed in **its own colour, from its own name** — FAM is green
because FAM emits green — so a hand-authored plate, or one opened with no run beside it, looks
exactly right with no calibration in sight. (In the app that table is `lib/fluorColors.ts`.)

Where a channel *is* wanted anyway — ordering the fluor list, and labelling a chip `Ch1` — it
comes from the run's own calibration: `ParsePlateCsvOptions.channelForFluor`, normally wired to
`Dcal.primaryChannel` via `zpcr.ts`'s `dyeChannelLookup`. With no lookup, or a dye it doesn't
cover, the channel is simply **unknown** (`PlateFluor.channel` / `WellFluor.channel` left
`undefined`), and the UI omits it rather than flagging it — an unknown channel costs a label, not
a colour. It is never inferred from column position, since position carries no meaning and a
positional guess would produce a wrong answer that looks plausible rather than a missing one.

> A heading that happens to look like `FAM Ch1` is therefore just a dye whose name is `FAM Ch1`,
> matched verbatim against the calibration like any other. Earlier versions parsed that as a
> channel; nothing writes or reads it that way now.

## 5. Editing a plate, and the clipboard block

This is the one plate encoding zpcrweb can **write**, so it is also the only one it can edit: the
app's plate editor works on a `PlateDefinition` and saves through `plateToCsv`. A `.pltd` has no
writer, and gets no editor rather than one that couldn't save.

The edit operations themselves are `packages/core/src/plateEdit.ts` — pure
`PlateDefinition → PlateDefinition` functions, so the UI owns the interaction and the library owns
what a plate may look like afterwards. What that costs the format is nothing; what it protects is
the three things a hand edit gets wrong, each of which would otherwise produce a file that reads
back as something else than what was on screen:

| Invariant | Why the format cares |
|---|---|
| `loaded`, `dyeCount`, `targets`, `samples` are recomputed from the wells | `parsePlateCsv` derives all four on read (§1, §3), so an edit that sets a target without updating the list writes a plate that disagrees with itself. |
| A well is loaded iff it carries a fluor | That *is* the read rule (§4). Any other rule survives on screen and not through a save. |
| The vessel stays stated once | §3.1 rejects a file that states it twice, so giving one well its own vessel pushes the plate's down onto the others, and wells that all agree hoist back up. |

`WellPatch` is the unit of an edit, and **every field is optional, with absent meaning "leave this
alone"** — which is what lets one edit set the sample across a column without disturbing the
targets in it.

### 5.1 The clipboard block

Copying wells between plates, or to and from a spreadsheet, uses **tab-separated** text
(`packages/core/src/plateClipboard.ts`, `formatPlateBlock`/`parsePlateBlock`) rather than this CSV:
TSV is what a spreadsheet puts on the system clipboard and reads back off it. The columns are the
same fields spelled the same way as §3's — the optional ones written only when some copied well
carries one, a fluor column per dye holding that well's target, `+` for present-with-no-target — so
a cell means the same thing in both formats. A blank cell **clears** the field, which is what makes
copying an empty well over a loaded one empty it.

One well is several tab-separated fields, so a copied block leads with a header row naming them;
each subsequent line is one plate row, holding `width × wells` cells. On paste, a first row whose
cells are non-empty, distinct, and include at least one known column name is read as that header —
which is also how a paste introduces a dye the plate doesn't have yet (`Sample⇥Cy5`). Without a
header the columns are positional: `Sample`, `SampleType`, then the plate's dyes in order, so the
commonest paste of all — a bare column of names out of a spreadsheet — sets the samples. A row
shorter than the columns says nothing about the ones it doesn't reach, rather than clearing them.

## 6. What's deliberately not in the file

- **The plate's identity** (`PlateDefinition.identityKey`, its user-facing name) — the
  file/archive-entry name *is* that identity. `parsePlateCsv`'s `sourceName` option derives it by
  stripping `.plt.csv` (or a bare `.csv`) and any directory part.
- **Fluor channels** — see §4.1. They belong to the instrument, and nothing the file is for
  needs them.
- **CFX-specific fidelity** (`meta`/`fluorId` and the like) — this is deliberately not a CFX
  format, so it isn't a decoder doc in the README's format-doc table alongside the reverse-engineered
  ones.
