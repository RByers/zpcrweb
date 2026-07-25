# Bio-Rad CFX `.pcrd` Data-File Format

Reverse-engineered from `samples/20260720_Luna_noRT.pcrd`, the CFX Manager **data file** for the
same run as `samples/20260720.zpcr` (`20260720_211747_CT019138_Luna_noRT`, a CFX96 `CT019138`).
Where a `.zpcr` is the *instrument's* raw output — a directory of files zipped up as the run
proceeds — a `.pcrd` is the *application's* saved document: the whole experiment, plus its
analysis state, collapsed into a single XML file.

> **Status:** container fully decoded; payload structurally mapped and cross-validated against
> the `.zpcr` for the same run. All 45 plate reads decode, and every fluorescence and dark-current
> value is bit-for-bit identical to the corresponding binary `.Plateread` (§3.1). The analysis-state
> subtrees (§3.5) are mapped but not interpreted.

---

## 1. Container — identical to `.pltd`

A `.pcrd` is the **same single-entry encrypted ZIP** as a `.pltd`/`.prcl`
([`pltd.md`](./pltd.md) §1), with a GUID-named inner entry whose extension echoes the outer
file. The sample is **variant B**, field for field:

| Field | Value |
|-------|-------|
| Leading bytes | `50 4B 07 08` spanning marker, then `50 4B 03 04` |
| GP flag | `0x000B` — bit 0 encrypted, bit 3 data descriptor |
| Method | `8` = Deflate |
| `version-made-by` | `45` |
| Extra field | UTF-16 copy of the filename (`NU`/`NUCX`) |
| Entry name | `3106341c-b0f0-4dbe-ae82-ac668ff98fdb.pcrd` |

Parse via the **central directory**, as with `.pltd` — under variant B the local header's
CRC/sizes are zero placeholders and the real values live in the central-directory record.
The existing `zipcrypto.ts` + `inflate.ts` handle this container unchanged; only the payload
parser differs.

Deflate64 (method 9) has not been observed in a `.pcrd` yet, but the writer is the same ZIP
library that emits it for `.pltd`, so assume both methods are possible.

## 2. Encryption — same fixed password as `.pltd`

Traditional PKWARE (ZipCrypto), 12-byte encryption header, and — confirmed on the sample —
**the same fixed standard-mode password** used for `.pltd`/`.prcl`. A single password entry
unlocks plate definitions, protocols and data files alike.

As with `.pltd`, **this project does not ship the password**; see
[`pltd.md`](./pltd.md) §2 for how to recover it from a licensed CFX Manager installation.

Decrypting the sample yields 2,482,825 bytes whose CRC32 matches the central directory exactly.

## 3. Payload — the `<experimentalData2>` XML

The inflated entry is a UTF-8 (BOM-prefixed) XML document, ~2.4 MB, on a single line with no
line terminators. Its root gathers what the `.zpcr` spreads across many files:

```
<experimentalData2 exType="User" protocolEdited="False" …>
  <identifier identityKey="20260720_211747_CT019138_Luna_noRT.pcrd"/>
  <header … createdByClientApp="BioRadCFXManager.exe" guid=… />
  <plateSetup2 …>…</plateSetup2>            <!-- the .pltd payload -->
  <protocol2 …>…</protocol2>                <!-- the .prcl payload -->
  <runData channelCount="6" wellsCount="96">
    <calibrationCollection>…</calibrationCollection>   <!-- the .Dcal files -->
    <plateReadDataVector>
      <plateRead><PlateRead V="1">…</PlateRead></plateRead>   <!-- ×45, one per cycle -->
    </plateReadDataVector>
  </runData>
  <hardwareSoftwareInfo …>…</hardwareSoftwareInfo>
  <protocolRunInfo><RunInfo><KeyValuePairs>…       <!-- RunInfo.xml -->
  <wellFactorsCollection>…</wellFactorsCollection>
  <dataAnalysisParameters …>…</dataAnalysisParameters>
  <qcAnalysisParameters/> <precisionMeltCalibration/>
  <PersistedData>…</PersistedData>          <!-- UI/view state -->
  <log … />                                 <!-- ×93, = runlog.xml -->
  <auditHeader … ><changes/></auditHeader>
</experimentalData2>
```

### Mapping to `.zpcr` entries

| `<experimentalData2>` child | `.zpcr` equivalent |
|---|---|
| `plateSetup2` | the `.pltd` payload (`<platesetup2>`) |
| `protocol2` | the `.prcl` payload |
| `runData/plateReadDataVector` | `Read000NN.Plateread` (one `<plateRead>` each) |
| `runData/calibrationCollection` | the 28 `*.Dcal` files (§3.6) |
| `protocolRunInfo/RunInfo` | `RunInfo.xml` |
| `log` (repeated) | `runlog.xml` |
| `wellFactorsCollection`, `dataAnalysisParameters`, `PersistedData`, `qcAnalysisParameters`, `precisionMeltCalibration` | **no equivalent** — application analysis/UI state |
| `hardwareSoftwareInfo`, `auditHeader`, `header` | provenance; partly overlaps `RunInfo.xml` |

Note the case difference: the root child is `plateSetup2` (capital `S`) while the standalone
`.pltd` root is `platesetup2` (all lower). The child schemas are otherwise the same.

### 3.1 `runData` — the plate reads

`<runData channelCount="6" wellsCount="96">` holds one `<plateRead>` wrapper per cycle, each
containing a `<PlateRead V="1">` with:

| Child | Contents |
|-------|----------|
| `SerVersion` | serializer version (`2`) |
| `Hdr/PlateReadDataHeader` | the binary file's scalar header, one element per field (§3.2) |
| `Data/PAr` | **WELLDATA** — the fluorescence table, as text |
| `Unique`, `Time`, `Name`, `Interp` | wrapper bookkeeping (`Time="-1"`, `Interp="False"` on all 45) |

**`PAr` is the binary `WELLDATA` array verbatim**, semicolon-separated decimal floats:
**2592 values = 648 records × 4**, in the same record order as the binary file
(`record_index = channel * 108 + row * 12 + col`), each record being
`mean;stddev;min;max`. See [`plateread.md`](./plateread.md) §2 for the grid semantics — 6
channels × 108 wells, 9 rows where row 8 is the reference row.

Likewise `Hdr/PlateReadDataHeader/DrkCrnt/PAr` is the binary **DARKDATA** array: 24 values =
6 channels × the same 4-tuple.

**Cross-validation.** For all 45 reads of the shared sample run, every value matches the
corresponding `Read000NN.Plateread` exactly:

| Array | XML source | Binary source | Result |
|-------|-----------|---------------|--------|
| WELLDATA | `Data/PAr` | `0x1A8`, 2592 × f32 LE | 45/45 reads, 2592/2592 values |
| DARKDATA | `DrkCrnt/PAr` | `0x2A2C`, 24 × f32 LE | 45/45 reads, 24/24 values |

The first tuple of cycle 1 reads `2272.885, 7.044312, 2258, 2287` from both.

> **Erratum for [`plateread.md`](./plateread.md):** the `uint32` count word that frames each
> array (`0x1A4` for WELLDATA, `0x2A28` for DARKDATA) is **little-endian**, like the float data
> it introduces — not big-endian like the surrounding metadata. Read big-endian, WELLDATA's
> count of `2592` comes out as `537526272`. The float payloads therefore start at `0x1A8` and
> `0x2A2C`.

### 3.2 `PlateReadDataHeader` — the scalar header as elements

42 child elements, each a scalar with text content — the same fields
[`plateread.md`](./plateread.md) §3 recovers from the binary header via its descriptor
dictionary, but named and already typed, so no offsets or endianness are involved. Values for
cycle 1 of the sample:

| Element | Value | Element | Value |
|---------|-------|---------|-------|
| `SerVersion` | `9` | `PRVersion` | `2` |
| `CRC` | `0` | `ChCount` | `6` |
| `HeadSerNum` | `SG16130` | `ChMask` | `63` (all 6 channels) |
| `AlphaSerNum` | `785BR13647` | `SamTmp` | `60` |
| `BaseSerNum` / `RunGUID` | `CT019138` | `LidTmp` | `105` |
| `ScMode` / `ScIdx` | `0` / `1` | `LedCur01`…`LedCur06` | `92, 97, 76, 123, 185, 161` |
| `RtrvlType` | `3` | `FanState`, `FanOffTmp`, `FanOnTmp` | `1`, `35`, `40` |
| `StepId`, `Step`, `Cycle` | `0`, `2`, `1` | `LidForce`, `LidState`, `LidPos` | `1`, `1`, `0` |
| `ErrNum`, `ErrDesc` | `0`, empty | `Time` | `Tue, 21 Jul 2026 05:23:17 GMT` |
| `BlockTmp` | `59.99` | `Offset` | `0` |
| `ShtTmp`, `AmbTmp` | `44.4`, `28` | `FWVersions` | firmware banner string |
| `ChNum` | `0` | `ShuttleParams` | empty |
| `NumCols`, `NumRows` | `12`, `9` | `DrkCrnt` | DARKDATA (§3.1) |

`BlockTmp = 59.99` confirms `plateread.md`'s big-endian correction — the read happens at the
60 °C step. `NumRows = 9` is the 8 plate rows plus the reference row.

### 3.3 `plateSetup2` — the plate definition

Same schema as the `.pltd` payload ([`pltd.md`](./pltd.md) §3): `geneNameList`,
`conditionNameList`, `dyeLayersList` (one `<dyeLayer>` per fluorophore, each with a `<fluor>`
and 96 `<wellSample>`), `analysisSets`, `TraceStyles`, `ExcludeSampleTypes`. The same
`wellSampleType` enum applies.

The sample carries plate data that neither `.zpcr` in `samples/` has (this run's archive
contains no `.pltd` at all): `rows=8 columns=12 dyes=3 plateName="BR Clear"
scanMode="AllChannelsScan"`, targets `HRV Ma, HMPV Ma, RSV Ma, ENT rc, PIV3 Bo`, conditions
`S181, S137`, dye layers `FAM, Texas Red, Cy5`.

### 3.4 `protocol2` — the thermal protocol

Same payload as a `.prcl`. Attributes carry the run-level settings
(`lidTemperature="105"`, `volume="20"`, `shutoffTemperature="30"`, `isRealTime`, …) and the
familiar one-line summary:

```
runDefinition="METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 95.0,10;TEMP 60.0,30;PLATEREAD #h3F;GOTO 2,44;END;"
```

`protocol2BaseList` expands that into typed steps — a discriminated union by element name:

| Element | Attributes |
|---------|-----------|
| `TemperatureStep` | `temperatureStepTemp`, `temperatureStepHoldTime`, `temperatureStepNumber` |
| `GotoStep` | `optionGotoStep`, `optionGotoCycle`, `optionGotoStepNumber` |

The sample: 95 °C/60 s, 95 °C/10 s, 60 °C/30 s, then goto step 1 × 44 — i.e. 45 cycles, matching
the 45 plate reads. Step numbers are 0-based here while `runDefinition`'s `GOTO 2,44` is
1-based. Melt/other step types are expected but not present in this sample.

### 3.5 Analysis and application state (not interpreted)

No `.zpcr` equivalent — this is what CFX Manager adds on top of the raw run:

- **`dataAnalysisParameters`** (~37 KB) — `selectedStepNumber`, `algorithmCtDetection`,
  `TargetsAsFluors`, then a `dataAnalysisParam` per well group carrying baseline/threshold
  settings (`smoothFilterWidthPref`, `subsetPopRDBaseLinePref`, `BeginCyclesSkip`,
  `EndCyclesSkip`, `pcrActiveFluors`, melt-temp offsets) plus `fluorsDataAnalysisParams`
  (per-fluor, 8 in the sample), `adDataAnalysisParams`, `fsdDataAnalysisParams`,
  `OligoContentParams` and `geneExpressionData`. **This is where Cq values and thresholds come
  from** — the most valuable subtree to decode next.
- **`wellFactorsCollection`** (~3.7 KB) — `WFHeader`, `SnrWF`, `FlyoverWF`; per-well correction
  factors applied to the raw fluorescence.
- **`PersistedData`** (~39 KB) — `PD_ContentData` + `PD_ViewSettings`, tagged
  `BioRad.Common.Xml.PersistableData`; UI state (chart selections, colours), not run data.
- **`qcAnalysisParameters`**, **`precisionMeltCalibration`** — empty in this sample.

These subtrees use a distinct serializer convention: a `V="1"` attribute on the wrapper, a
`SerVersion` text child, and sometimes a `___TypeInfo` child naming the .NET type.

### 3.6 `calibrationCollection` — the embedded `.Dcal` data

**The single largest subtree: ~1.4 MB serialized, 56% of the whole document.** It absorbs what
the `.zpcr` keeps as 28 separate `*.Dcal` files (`FAM_BR Clear.Dcal`, `Cy5_BR White.Dcal`, …).

```
<CalibrationCollection V="1">
  <SerVersion>1</SerVersion>
  <Fluors>      <!-- <Ar><I><Fluorophor V="1"> — Id, Name ("Cal Gold 540"), Usage,
                     IsDel, EmFilter/ExFilter <Filter V="1"> with Id/Type/Name -->
  <FactoryCals> <!-- factory pure-dye calibrations -->
  <UserCals>    <!-- user-run calibrations -->
```

The `Name` values line up with the `.Dcal` filename stems, and the `_BR Clear` / `_BR White`
split corresponds to plate type. Not decoded further — the sample's amplification data needs
none of it.

### 3.7 Provenance

- **`header`** — `currentVersion="06.10"`, the original Windows path, `createdDate`/`modifiedDate`,
  `guid`, and the writing application: `BioRadCFXManager.exe` version `3.1.1621.0826`, with
  `BioRadC1000Server.exe` as the DA server, plus OS/CLR/culture. Note the file's `createdDate`
  (2026-07-23) is three days *after* the run — the `.pcrd` is written when the run is opened and
  saved in CFX Manager, not by the instrument.
- **`hardwareSoftwareInfo`** — host CPU/OS details and 114 `<appFile name version createDate>`
  records for the installation's DLLs.
- **`log`** (×93) — flat sibling elements, attributes `lgNm, level, ts, assemblyName, sev, data,
  tag, msgNm, msg, stack`. Same content as `runlog.xml`; the first entry restates the whole run
  configuration, and per-cycle entries read `Plate read success, scan# 25, at step: 4, cycle 25.`
- **`auditHeader`** — `user`, `computerName`, `date`, `comments`, `signature`/`signatureComments`
  (21 CFR 11 e-signature fields, empty here) and a `<changes/>` list.

Interestingly the first log entry names the data file as
`20260720_211747_CT019138_Luna_noRT.zpcr` — the `.pcrd` records the `.zpcr` it was built from.

---

## 4. Implementation notes

- The container needs no new code: the `.pltd` path (central-directory parse → ZipCrypto →
  inflate) applies unchanged. Only dispatch on the payload root element.
- With no password, do what `parsePltd` does — return the container with `needsPassword: true`
  rather than throwing.
- `PAr` parsing is the hot path: 45 × 2592 decimal floats, ~810 KB of text. Split on `;` and
  parse to a `Float32Array` shaped exactly like the binary `WELLDATA`, so a `.pcrd` and a
  `.zpcr` can feed the *same* `PlateRead[]` → `toCurves()` → `WellCurve[]` pipeline. The
  separator is a pure delimiter — no leading or trailing empty fields in any of the 45 reads.
- `calibrationCollection` is **56% of the document** (~1.4 MB serialized). If parsing lazily,
  skip it by default; a streaming or subtree-skipping parse matters more here than anywhere else.
- A `.pcrd` is a superset of its `.zpcr` for everything except the `.Dcal`/`.alf` raw files, so
  it is the better input where both exist — and the only input carrying analysis state.
