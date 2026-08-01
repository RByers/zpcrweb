# `.prcl` — thermal-cycling protocol files

A `.prcl` file is one **thermal-cycling protocol**: the lid temperature, sample volume, and the
ordered list of steps the instrument executes (hold at 95 °C, cycle 40×, melt from 65 → 95 °C, …).
It is the "what the machine does" half of a run; `.pltd` (see [`pltd.md`](./pltd.md)) is the "what
is in each well" half.

> **Status: fully decoded.** The container is the same encrypted ZIP as `.pltd`/`.pcrd` (see
> [`zipcrypto.md`](./zipcrypto.md)) and the payload is plain XML with a small, self-describing
> schema. Validated against the committed samples —
> `Short Qualification_Plate_96.prcl` inside
> `samples/20190516_122922_CT019138_SHORT_QUALIF.zpcr`, and the `protocol2` document embedded in
> `samples/20260720_Luna_noRT.pcrd` — plus 31 protocol files shipped with a licensed CFX Manager
> installation, covering hold/cycle, gradient, melt, genotyping, conventional and real-time
> protocols.
>
> Implemented by `packages/core/src/prcl.ts` (`parsePrcl(bytes)`, plus `parseProtocol2(xml)` for
> the standalone `<protocol2>` fragment `pcrd.ts` reuses), on top of the existing `zipsingle.ts` +
> `zipcrypto.ts` + `inflate.ts`. Both container variants below are sniffed and handled — the ZIP
> variant using variant B's container quirks (`zipcrypto.md` §"variant B": leading spanning
> marker, data descriptor) same as `.pltd`.

---

## 1. Container

Identical to `.pltd`: a single-entry ZipCrypto-encrypted ZIP, compressed with **DEFLATE
(method 8) or DEFLATE64 (method 9)**, sharing the one fixed standard-mode password documented in
[`zipcrypto.md`](./zipcrypto.md). The existing pipeline handles it as-is:

```ts
const entry = parseSingleEntryZip(bytes);
const xml = inflateRaw(
  zipCryptoDecrypt(entry.data, password),
  entry.uncompressedSize,
  entry.method === 9,          // DEFLATE64
);
```

Both methods occur in practice — most protocols are method 8, the pure-dye calibration protocols
are method 9 — so **a reader must pass the `deflate64` flag through** rather than assuming
method 8.

A `.prcl` also appears **as an entry inside a `.zpcr` archive**, carrying the protocol the run
executed (`Short Qualification_Plate_96.prcl` in the committed 2019 sample). It is byte-for-byte
the same format there, encrypted with the same password, so `zpcr.archive.bytes(name)` feeds
straight into the pipeline above. Not every archive includes one — the 2026 sample has none.

### 1.1 The plaintext variant

At least one shipped protocol (`BurnIn.prcl`) is **not a ZIP at all**. It is the bare
run-definition text, unencrypted and uncompressed, with a `.prcl` extension:

```
[ProtocolRunDefinition version 06.00]METHOD CALC;HOTLID 105,30;VOLUME 25;…
```

Sniff the leading bytes before choosing a path: a ZIP end-of-central-directory record → the XML
form below; a literal `[ProtocolRunDefinition` → the text form of §3 only. This variant carries
no XML step list, so the text grammar is the *only* representation of its steps.

## 2. Payload — `protocol2`

The decrypted payload is a small standalone XML document (~2.3–2.6 KB):

```xml
<?xml version="1.0" encoding="utf-8" standalone="yes"?>
<protocol2 lidTemperature="105" useDefaultLidTemperature="False" shutoffLidEnabled="False"
           shutoffTemperature="30" volume="20" isRealTime="True" isEmailWhenComplete="False"
           runDefinition="METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;…;END;">
  <identifier identityKey="Unknown.prcl" />
  <header tag="TCT" name="Unknown.prcl" currentVersion="06.00" … />
  <protocol2BaseList>
    <TemperatureStep temperatureStepTemp="95" temperatureStepHoldTime="60" temperatureStepNumber="0" />
    <TemperatureStep temperatureStepTemp="95" temperatureStepHoldTime="10" temperatureStepNumber="1" />
    <TemperatureStep temperatureStepTemp="60" temperatureStepHoldTime="30" temperatureStepNumber="2">
      <PlateReadOption optionId="PlateReadOption" />
    </TemperatureStep>
    <GotoStep optionGotoCycle="44" optionGotoStep="1" optionGotoStepNumber="3" />
  </protocol2BaseList>
</protocol2>
```

**This is the same element `.pcrd` embeds** as its `protocol2` subtree — see [`pcrd.md`](./pcrd.md)
§2.4. A `.pcrd` therefore carries a complete copy of the protocol used for the run, and one parser
serves both. The example above *is* the committed `.pcrd` sample's protocol: 95 °C/60 s, then
(95 °C/10 s → 60 °C/30 s + read) × 45.

### 2.1 Root attributes

| Attribute | Meaning |
|---|---|
| `lidTemperature` | Heated-lid setpoint, °C (105 in every file seen) |
| `useDefaultLidTemperature` | Whether the lid setpoint is the app default rather than user-set |
| `shutoffLidEnabled`, `shutoffTemperature` | Turn the lid heater off below this temperature |
| `volume` | Sample volume, µL — drives the instrument's thermal model |
| `isRealTime` | Real-time (plate-reading) protocol vs. a conventional thermal-cycler run |
| `isEmailWhenComplete` | Notification preference, not run data |
| `runDefinition` | The whole protocol as one text line — see §3 |

### 2.2 `identifier` and `header`

`identifier` holds only `identityKey` (the file name). `header` is pure audit/provenance metadata
and carries **no protocol information**: `name`, `guid`, `description`, `currentVersion` /
`originalVersion` (`06.00`), `fullyQualifiedName`, created/modified date, user, client app and
version, DA-server app and version, plus the authoring machine's `computerName` and `os*` fields.

Two notes for implementers:

- `tag="TCT"` in every file — the protocol counterpart of the `TCPS` tag on `.pltd` plate
  documents, and the same iQ5-era lineage described in [`pltd.md`](./pltd.md).
- `fullyQualifiedName` preserves the **authoring machine's absolute path**, and `computerName` /
  `createdByUser` name a real machine and account. Shipped sample protocols still carry their
  original build-machine paths. Treat these as incidental personal/environmental data: parse them
  if useful, but don't surface them in UI by default.

### 2.3 `protocol2BaseList` — the steps

An ordered list, a discriminated union keyed by element name. **Every step carries a 0-based
`*StepNumber`** matching its position in the list.

| Element | Attributes | Meaning |
|---|---|---|
| `TemperatureStep` | `temperatureStepTemp` (°C), `temperatureStepHoldTime` (s), `temperatureStepNumber` | Hold one temperature. A hold time of `0` appears as the final step of conventional protocols (`TEMP 12.0,0`), where it most likely denotes an indefinite hold — inferred from position and the conventional 12 °C storage hold, not confirmed. |
| `GradientStep` | `gradientStepLowTemp`, `gradientStepHighTemp`, `gradientStepRange`, `gradientStepHoldTime`, `gradientStepNumber` | Hold a **temperature gradient across the block's rows** — each row sits at a different temperature between low and high, for annealing optimization. |
| `MeltCurveStep` | `meltCurveStartTemp`, `meltCurveEndTemp`, `meltCurveHoldTime`, `meltCurveTemperatureIncrement`, `meltCurveStepNumber` | Ramp from start to end in increments, holding and plate-reading at each — the melt curve. |
| `GotoStep` | `optionGotoStep`, `optionGotoCycle`, `optionGotoStepNumber` | Loop back to step `optionGotoStep` (**0-based**) and repeat `optionGotoCycle` **additional** times. |
| `PlateReadOption` | `optionId` | **A child element, not a sibling** — marks its parent step as a plate read. |

Four points worth getting right, each of which is easy to get subtly wrong:

- **`PlateReadOption` nests inside the step it applies to.** It is not a step in its own right and
  has no step number. `optionId` is the constant string `"PlateReadOption"` in every file — it is a
  marker, not a channel selector. (The channel bitmask exists only in the `runDefinition` text; see
  §3.)
- **`GotoStep` counts *repeats*, not total passes.** `optionGotoCycle="44"` targeting step 1 yields
  **45** executions of the loop body, which is why the committed sample has 45 plate reads. Off by
  one here silently mis-numbers every cycle.
- **`gradientStepRange` is redundant** — it equals `gradientStepHighTemp − gradientStepLowTemp`
  (`65 − 50 = 15`). Derive it rather than trusting it, or at least don't treat a mismatch as fatal.
- **`MeltCurveStep` is a compression of several text tokens.** One element replaces the
  `TEMP`/`INC`/`RATE`/`PLATEREAD`/`GOTO` sequence the text form spells out (§3), so XML → text is
  not a token-for-token mapping. In particular **`meltCurveEndTemp` is not stored in the text at
  all** — it is implied by the loop:

  ```
  meltCurveEndTemp = meltCurveStartTemp + gotoRepeats × meltCurveTemperatureIncrement
  ```

  Confirmed on both melt samples: `56.5 + 7 × 5 = 91.5` (committed `SHORT_QUALIF` sample) and
  `65 + 60 × 0.5 = 95`. A reader parsing the text form must reconstruct the end temperature this
  way; one parsing the XML gets it directly.

## 3. `runDefinition` — the text form

The `runDefinition` attribute holds the **entire protocol as a single `;`-delimited line** — the
same grammar as the `ProtocolRunDefinition.txt` entry a `.zpcr` archive stores alongside a run.
Because it is stored inline rather than derived at read time, the structured steps and the text
form can be cross-checked against each other within a single file.

⚠️ **It is *not* byte-identical to `ProtocolRunDefinition.txt`.** Comparing the two inside the
committed `20190516…SHORT_QUALIF.zpcr`, which carries both, shows two systematic differences:

| | `.prcl` `runDefinition` | `ProtocolRunDefinition.txt` |
|---|---|---|
| Plate-read operand | `PLATEREAD #h3F` | `PLATEREAD #h81` |
| Terminator | `END;` | `END` + CRLF |

The archive's `.txt` is what the **instrument recorded for that run**; the `.prcl` is the
**protocol as authored**. Do not treat either as canonical for the other, and do not diff them
literally. The operand difference is not noise: the authored file has no channel information in
it, and the real scan mask is substituted from the *plate* when the run starts — see `usb.md`
§3.1, which decodes the operand.

```
METHOD CALC;HOTLID 105,30;VOLUME 25;TEMP 50.0,600;TEMP 95.0,300;TEMP 95.0,10;
TEMP 60.0,30;PLATEREAD #h3F;GOTO 3,39;TEMP 95.0,10;TEMP 65.0,31;TEMP 65.0,5;
INC 0.5;RATE 0.5;PLATEREAD #h3F;GOTO 9,60;END;
```

Complete verb inventory across all files examined:

| Verb | Operands | Notes |
|---|---|---|
| `METHOD` | `CALC` | Header; thermal control method |
| `HOTLID` | temp, shutoff | Mirrors `lidTemperature` / `shutoffTemperature` |
| `VOLUME` | µL | Mirrors `volume` |
| `TEMP` | temp, holdSeconds | → `TemperatureStep` |
| `GRAD` | lowTemp, highTemp, holdSeconds | → `GradientStep` |
| `INC` | °C | Per-cycle temperature increment (melt ramp step size) |
| `RATE` | °C/s | Ramp rate |
| `PLATEREAD` | `#h3F`, `#h81` | Scan mask, **hex** (`#h` prefix) — channels to read plus a sweep-mode bit; decoded in `usb.md` §3.1, and see below for why an authored file always says `#h3F` |
| `GOTO` | step, repeats | **1-based** step index — unlike the XML |
| `END` | — | Terminator (`END;` in `runDefinition`, bare `END` in the archive `.txt`) |

⚠️ **`GOTO` is 1-based in the text and 0-based in the XML.** The same loop appears as
`GOTO 3,39` in `runDefinition` and `optionGotoStep="2"` in `GotoStep`. Any cross-validation
between the two forms has to account for this.

**The `PLATEREAD` operand is a scan mask, and an authored `.prcl` never carries the real one.**
Bits 0–5 select optical channels 1–6 and bit 7 (`0x80`) picks the sweep — so `#h3F` is
"all six channels, step-and-repeat" and the run-time `#h81` is "channel 1 only, flyover", the
fast-scan configuration. `usb.md` §3.1 has the full decoding and the measurements behind it.

What matters here is that the `.prcl` side of it is **not** a channel selection: the structured
`PlateReadOption` element has no channel field (§2), and every authored file renders the step as
`#h3F` whatever the run will do. The mask that reaches the instrument comes from the plate
definition's `scanMode` (`pltd.md` §2), substituted at run start, and is what the recorded
`ProtocolRunDefinition.txt` reports. So `#h3F` in a `.prcl` means "unspecified", not
"all channels" — **preserve the raw value** and read the run's actual mask from
`ProtocolRunDefinition.txt`, `RunInfo.xml`'s `ScanMask`, or any `.Plateread`'s `CHANNELMASK`.

### 3.1 `.prcl.txt` — this project's own text form

The one representation in this document that is **not** reverse-engineered: `.prcl.txt` is what
this project writes when a protocol has to leave the app as a file. It is the §3 grammar with one
directive per line, under the §1.1 plaintext header:

```
[ProtocolRunDefinition version 06.00]
METHOD CALC;
HOTLID 105,30;
VOLUME 20;
TEMP 95.0,60;
…
END;
```

The line breaks are presentational only — the grammar is `;`-delimited and ignores whitespace — so
this is the same protocol as the one-liner, just readable and diffable. Keeping the header means
the file **is a valid plaintext `.prcl`** rather than a listing of one: `parsePrcl` reads it back
with no new code path.

Implemented by `formatRunDefinitionText()` / `parseRunDefinitionText()` in
`packages/core/src/prcl.ts`. Reading is deliberately lenient about layout and strict about
content: the header is optional and directives may be split across lines however the writer liked
(so an instrument's own `ProtocolRunDefinition.txt` is accepted unchanged), but every directive
must start with a verb from §3's inventory — which is what makes picking a non-protocol file
report itself instead of yielding an empty protocol. The web app writes it from the Overview
tab and reads it in the Device view (`apps/web/ARCHITECTURE.md`, "The Device view").

**Why a text form exists at all.** A protocol that has to be handed to an instrument, or moved
between machines, wants a representation that isn't an encrypted container — see `usb.md` §5.1
for the evidence that the encrypted `.prcl`/`.pltd` pair is a CFX Manager concern rather than
something the instrument reads.

## 4. Open items

- **Channel subsets in the `PLATEREAD` mask** — the operand itself is decoded (§3, `usb.md` §3.1)
  and the authored-vs-recorded difference is explained, but only the two whole-configuration masks
  `#h3F` and `#h81` have ever been observed. Whether a mask selecting an arbitrary subset (or the
  expected FRET encoding) is even accepted is untested.
- **`METHOD` values other than `CALC`** — only `CALC` appears in the files examined.
- **`optionId`** — the constant string `"PlateReadOption"` in every file, so its value space is
  unknown. It may be an enum distinguishing plate-read variants in protocols not seen here.
- **The pre-melt `TEMP <start>,31` hold** — every melt protocol emits two holds at the melt start
  temperature (`TEMP 56.5,31; TEMP 56.5,5`) where only the second matches `meltCurveHoldTime`. The
  `31` is unexplained and has no XML counterpart.
- **`BurnIn.prcl`'s plaintext container** — is it a legacy form, or does the app still write it?
