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
| `# vessel: <name> <rows>x<columns>` | The only header line that matters. `<name>` is `PlateDefinition.plateName` — the consumable type (`BR Clear`, `BR White`), not the plate's own name (see §4) — spelled `vessel` so it can't be mistaken for that. `<rows>x<columns>` is the plate's extent; absent, the extent is inferred from the well labels seen in the table. |
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
| one column per fluorophore | no | See §4. |

Row order is presentation only: `parsePlateCsv` places each row by its own well label and derives
the plate's target/sample lists by walking the wells, so a file re-sorted in a spreadsheet, or
with rows in any order at all, reads back identically. `plateToCsv` writes column-major (`A1, B1,
C1, … A2, B2`), the order a plate is actually filled down. A well carrying nothing at all (see
`isBlankWell`) is left out of the table entirely — on a typical plate that's most of the wells —
and a well missing from the table parses back to exactly that; the header's `rows`/`columns` (or
the well labels seen) keep the plate's extent regardless.

## 4. Fluor columns

Every column that isn't one of the fixed ones (§3) is a fluor column, labelled with the dye name
alone (`FAM`, `Tex 615`) or with an explicit ` Ch<n>` suffix (1-based — the "FAM Ch1" form the app
displays), which wins over any other channel source if present. These columns *are* the plate's
whole fluor list — there's no separate header line to keep in sync — and are written in ascending
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

**Channel resolution**, when a column carries no ` Ch<n>` suffix: `ParsePlateCsvOptions.channelForFluor`
is called with the dye name — normally wired to the run's own `.Dcal` calibration
(`Dcal.primaryChannel`, via `zpcr.ts`'s `dyeChannelLookup`), since a dye is only ever read on one
channel and the run's optics say which. With neither a suffix nor a lookup answer, the channel is
**unknown** (`PlateFluor.channel` / `WellFluor.channel` left `undefined`) — never inferred from
column position, since position carries no meaning and a positional guess would produce a wrong
answer that looks plausible rather than a missing one. A plate CSV parsed with no
`channelForFluor` at all (i.e. read on its own, outside an archive) simply has unknown channels
throughout.

## 5. What's deliberately not in the file

- **The plate's identity** (`PlateDefinition.identityKey`, its user-facing name) — the
  file/archive-entry name *is* that identity. `parsePlateCsv`'s `sourceName` option derives it by
  stripping `.plt.csv` (or a bare `.csv`) and any directory part.
- **Fluor channels**, unless a column spells one out — see §4.
- **CFX-specific fidelity** (`meta`/`fluorId` and the like) — this is deliberately not a CFX
  format, so it isn't a decoder doc in the README's format-doc table alongside the reverse-engineered
  ones.
