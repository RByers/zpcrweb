# Bio-Rad CFX `.pcrd` Data-File Format

Reverse-engineered from `samples/20260720_Luna_noRT.pcrd`, the CFX Manager **data file** for the
same run as `samples/20260720_FirstQualification.zpcr` (`20260720_211747_CT019138_Luna_noRT`, a CFX96 `CT019138`).
Where a `.zpcr` is the *instrument's* raw output — a directory of files zipped up as the run
proceeds — a `.pcrd` is the *application's* saved document: the whole experiment, plus its
analysis state, collapsed into a single XML file.

> **Status:** container fully decoded; payload structurally mapped and cross-validated against
> the `.zpcr` for the same run. All 45 plate reads decode, and every fluorescence and dark-current
> value is bit-for-bit identical to the corresponding binary `.Plateread` (§2.1). `calibrationCollection`
> (§2.6) is likewise fully decoded and value-for-value cross-validated against the real `.Dcal`
> files, as is `wellFactorsCollection` (§2.5). The remaining analysis-state subtrees (§2.5) are
> mapped but not interpreted.

---

## 1. Container and encryption — identical to `.pltd`

A `.pcrd` is the **same single-entry encrypted ZIP** as a `.pltd`/`.prcl` — see
[`zipcrypto.md`](./zipcrypto.md) for the container variants, encryption and the shared fixed
password. It has a GUID-named inner entry whose extension echoes the outer file. The sample is
**variant B**, field for field:

| Field | Value |
|-------|-------|
| Leading bytes | `50 4B 07 08` spanning marker, then `50 4B 03 04` |
| GP flag | `0x000B` — bit 0 encrypted, bit 3 data descriptor |
| Method | `8` = Deflate |
| `version-made-by` | `45` |
| Extra field | UTF-16 copy of the filename (`NU`/`NUCX`) |
| Entry name | `3106341c-b0f0-4dbe-ae82-ac668ff98fdb.pcrd` |

Deflate64 (method 9) has not been observed in a `.pcrd` yet, but the writer is the same ZIP
library that emits it for `.pltd`, so assume both methods are possible.

Confirmed on the sample: decrypting yields 2,482,825 bytes whose CRC32 matches the central
directory exactly, using the same fixed standard-mode password as `.pltd`/`.prcl`. A single
password entry unlocks plate definitions, protocols and data files alike. The existing
`zipcrypto.ts` + `inflate.ts` handle this container unchanged; only the payload parser differs.

## 2. Payload — the `<experimentalData2>` XML

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
| `runData/calibrationCollection` | the 28 `*.Dcal` files (§2.6) |
| `protocolRunInfo/RunInfo` | `RunInfo.xml` |
| `log` (repeated) | `runlog.xml` |
| `wellFactorsCollection` (decoded, §2.5), `dataAnalysisParameters`, `PersistedData`, `qcAnalysisParameters`, `precisionMeltCalibration` | **no equivalent** — application analysis/UI state |
| `hardwareSoftwareInfo`, `auditHeader`, `header` | provenance; partly overlaps `RunInfo.xml` |

Note the case difference: the root child is `plateSetup2` (capital `S`) while the standalone
`.pltd` root is `platesetup2` (all lower). The child schemas are otherwise the same.

### 2.1 `runData` — the plate reads

`<runData channelCount="6" wellsCount="96">` holds one `<plateRead>` wrapper per cycle, each
containing a `<PlateRead V="1">` with:

| Child | Contents |
|-------|----------|
| `SerVersion` | serializer version (`2`) |
| `Hdr/PlateReadDataHeader` | the binary file's scalar header, one element per field (§2.2) |
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

### 2.2 `PlateReadDataHeader` — the scalar header as elements

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
| `NumCols`, `NumRows` | `12`, `9` | `DrkCrnt` | DARKDATA (§2.1) |

`BlockTmp = 59.99` confirms `plateread.md`'s big-endian correction — the read happens at the
60 °C step. `NumRows = 9` is the 8 plate rows plus the reference row.

The temperatures and the six `LedCur*` drive currents are mapped back onto the canonical
`*TEMP*`/`LEDCURRENT*` field names the binary header uses and run through the same
`temps.ts`/`leds.ts` extraction, so both formats produce identical `PlateRead.temps` /
`PlateRead.leds` (asserted read-for-read against the matching `.zpcr` in `pcrd.test.ts`).

### 2.3 `plateSetup2` — the plate definition

Same schema as the `.pltd` payload ([`pltd.md`](./pltd.md) §2): `geneNameList`,
`conditionNameList`, `dyeLayersList` (one `<dyeLayer>` per fluorophore, each with a `<fluor>`
and 96 `<wellSample>`), `analysisSets`, `TraceStyles`, `ExcludeSampleTypes`. The same
`wellSampleType` enum applies.

The sample carries plate data that neither `.zpcr` in `samples/` has (this run's archive
contains no `.pltd` at all): `rows=8 columns=12 dyes=3 plateName="BR Clear"
scanMode="AllChannelsScan"`, targets `HRV Ma, HMPV Ma, RSV Ma, ENT rc, PIV3 Bo`, samples
`S181, S137`, dye layers `FAM, Texas Red, Cy5`.

### 2.4 `protocol2` — the thermal protocol

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

`protocol2`'s own `identifier identityKey="…"` and `header name="…"` (same schema as a
`.prcl`'s, `prcl.md` §2.2) are the only source of a protocol *name* inside a `.pcrd` — there is
no separate friendly-name file the way `.zpcr` has `ProtocolName.txt`. In the sample both read
`Unknown.prcl`, the generic name CFX Manager gives an ad-hoc/unsaved protocol; a run against a
protocol that was saved to a named `.prcl` file would presumably carry that file's name here
instead. `zpcr.protocol()` (see the root `ARCHITECTURE.md`) exposes this via `parseProtocol2`,
reused unchanged from `prcl.ts`.

### 2.5 Analysis and application state (mostly not interpreted)

No `.zpcr` equivalent — this is what CFX Manager adds on top of the raw run:

- **`dataAnalysisParameters`** (~37 KB) — `selectedStepNumber`, `algorithmCtDetection`,
  `TargetsAsFluors`, then a `dataAnalysisParam` per well group carrying baseline/threshold
  settings (`smoothFilterWidthPref`, `subsetPopRDBaseLinePref`, `BeginCyclesSkip`,
  `EndCyclesSkip`, `pcrActiveFluors`, melt-temp offsets) plus `fluorsDataAnalysisParams`
  (per-fluor, 8 in the sample), `adDataAnalysisParams`, `fsdDataAnalysisParams`,
  `OligoContentParams` and `geneExpressionData`. **This is where Cq values and thresholds come
  from.** The per-fluorophore `pCRDataAnalysisParams` inside `fluorsDataAnalysisParams` — baseline
  mode and method, digital filter, auto/manual baseline and threshold flags, baseline begin/end
  cycles, threshold override — are interpreted in [`threshold.md`](./threshold.md), which
  specifies the baseline/threshold/Cq algorithms they configure. The remaining sub-elements
  (`adDataAnalysisParams`, `fsdDataAnalysisParams`, `OligoContentParams`, `geneExpressionData`)
  are still uninterpreted.

  **`thresholdOverrideValue` is authoritative and exact.** In
  `samples/20260726_S183-S185_RVP.pcrd` the FAM entry (`fluorId="5"`) carries
  `autoCalculateThreshold="False"` and `thresholdOverrideValue="92.0212554931641"`. Solving each
  FAM well's exported Cq back through the threshold-crossing rule recovers **the same 15 digits**
  — see [`threshold.md`](./threshold.md) §1.3. So this field is not a hint: feeding it to the Cq
  stage reproduces CFX's own answers bit for bit. `parsePcrd` decodes it into
  `Zpcr.persistedThresholds`, keyed by dye name (resolved from the plate's own
  `<dyeLayer><fluor fluorId= fluorName=>` entries, since the document carries an entry for every
  fluorophore CFX knows about, not just the plate's), and the web app seeds its own
  per-fluorophore threshold override from it. A dye left on `autoCalculateThreshold="True"`
  persists `NaN` here and the threshold CFX used is *not* stored anywhere in the file — in that
  sample Cy5 (`fluorId="4"`) and Tex 615 (`fluorId="11"`) are both on auto.

  **`baselineBeginRepeat` / `baselineEndRepeat` are not.** Both RVP fluorophores persist `2`/`9`
  while also carrying `autoCalculateBaseline="True"`, and the regions CFX actually used (inferred
  from its exported corrected curves) are frequently nowhere near cycles 2–9. Read these as the
  defaults the auto search starts from; trust them as an actual region only when
  `autoCalculateBaseline="False"`. This library deliberately does not read them at all.

  Note also that no *results* live in this tree, or anywhere else in a `.pcrd`: the file holds the
  raw plate reads and the analysis **settings**, and CFX recomputes the corrected curves, Cq values
  and end-point RFU on load. To get its answers you need its CSV exports — see §2.5a.
- **`wellFactorsCollection`** (~3.7 KB) — **decoded** (unlike the rest of this section), since it
  is the only source of the per-well gain factors [`calibration.md`](./calibration.md) §4.1
  applies to a raw reading. `WFHeader` is a `WellFactorsHeader` giving `Channels`, `Wells`, the
  instrument serials, and the `snrSaved`/`flyovrSaved` flags; `SnrWF` and `FlyoverWF` each hold a
  `WellFactors` element with one `<ChN><PAr>` per channel, a `;`-separated float per well in
  row-major order (108 for a 96-well block, reference row included). The two flags say which set
  was really recorded — in this sample **neither** is, the header notes the table was "created in
  Persistence loading", and every factor is exactly `1`. Decoded by `decodeWellFactors` in
  `pcrd.ts` into `Zpcr.wellFactors`; a `.zpcr` has no equivalent and leaves it undefined.
- **`PersistedData`** (~39 KB) — `PD_ContentData` + `PD_ViewSettings`, tagged
  `BioRad.Common.Xml.PersistableData`; UI state (chart selections, colours), not run data.
- **`qcAnalysisParameters`**, **`precisionMeltCalibration`** — empty in this sample.

These subtrees use a distinct serializer convention: a `V="1"` attribute on the wrapper, a
`SerVersion` text child, and sometimes a `___TypeInfo` child naming the .NET type.

### 2.5a The CSV exports — the reference answers a `.pcrd` doesn't contain

Because a `.pcrd` stores settings and raw reads but no computed results (§2.5), CFX Manager's
own numbers are only obtainable through its export function, which writes a ZIP of CSVs. One such
export is committed beside its experiment as
`samples/20260726_S183-S185_RVP-export.zip`, and it is the only ground truth this project has for
the analysis pipeline:

| CSV | Contents |
|---|---|
| `… Quantification Amplification Results_<fluor>.csv` | Baseline-corrected RFU: one row per cycle, one column per loaded well. **The output of the baseline stage.** |
| `… Quantification Cq Results_0.csv` | One row per well/fluor: target, content, sample, **Cq**, Cq mean/SD, starting quantity, set point. |
| `… End Point Results_<fluor>.csv` | **End RFU** (the mean of the corrected curve's last 5 cycles), plus `Call` / `Sample Type` / `CallType` / `Is Control`. |
| `… Quantification Plate View Results_<fluor>.csv` | The same Cq values laid out as a plate grid. |
| `… Quantification Summary_0.csv` | Well / fluor / target / content / sample / Cq / SQ. |
| `… Melt Curve Plate View Results_<fluor>.csv` | Melt peaks per well. |
| `… Gene Expression Results - Bar Chart_0.csv` | Relative-quantity table, keyed `<dataset>-<fluor>` × target × sample. |
| `… Standard Curve Results_….csv` | Efficiency %, slope, y-intercept, R² per fluor (`N/A` with no standards). |
| `…_Run Information.csv` | Run start/end, sample volume, lid temp, protocol and plate file names, base and optical-head serials, CFX Manager version. |

Format notes: every row starts with an empty leading field (so column 0 is blank), wells are
zero-padded (`A04`), numbers carry ~15 significant digits, and a missing value is the literal
`NaN`. The amplification CSV's `Cycle` column is the abscissa the reported Cq values are expressed
in — [`threshold.md`](./threshold.md) §1.3 confirms this by solving Cq back for the threshold.

Requesting an export alongside any newly captured `.pcrd` costs nothing and is the difference
between a sample that can be *read* and one that can be *validated against*.

### 2.6 `calibrationCollection` — the embedded `.Dcal` data

**The single largest subtree: ~1.4 MB serialized, 56% of the whole document.** It absorbs what
the `.zpcr` keeps as 28 separate `*.Dcal` files (`FAM_BR Clear.Dcal`, `Cy5_BR White.Dcal`, …).
Fully decoded and cross-validated: every field and every payload value for all 28 (dye, plate
type) pairs matches the corresponding binary `.Dcal` exactly (see `dcal.md`) — implemented by
`decodeCalibrationCollection`/`parseCalibrationDataElement` in `packages/core/src/pcrd.ts`,
wired into `zpcr.calibrations()`.

```
<CalibrationCollection V="1">
  <SerVersion>1</SerVersion>
  <Fluors><Ar V="1">
    <I><Fluorophor V="1">
      <SerVersion>4</SerVersion>
      <Id>0</Id>
      <Name>Cal Gold 540</Name>              <!-- matches a CalibrationData's <Dye> below -->
      <Usage>Unassigned</Usage>
      <IsDel>False</IsDel>
      <EmFilter>…</EmFilter> <ExFilter>…</ExFilter>  <!-- <Filter V="1"> Id/Type/Name, often empty -->
      <Clr>-16744384</Clr>
      <Units />
      <Channel>1</Channel>                    <!-- 0-based primary channel — already matches
                                                    this library's convention, no ±1 needed -->
      <IsFactory>True</IsFactory>
    </Fluorophor></I>
    …                                          <!-- one per dye the instrument knows, not per
                                                    (dye, plate) pair -->
  </Ar></Fluors>
  <FactoryCals><Ar V="1" /></FactoryCals>      <!-- empty in this sample -->
  <UserCals><Ar V="1">
    <I><CalibrationData V="1">
      <SerVersion>5</SerVersion>
      <FileType>4</FileType>
      <Version />
      <CreationTime>Mon, 01 Jan 0001 05:00:00 GMT</CreationTime>  <!-- .NET DateTime.MinValue:
                                                                        unset, not a real date -->
      <Notes>0165|CC050815A4|7|</Notes>        <!-- matches the binary NOTES field verbatim -->
      <Dye>Cal Gold 540</Dye>
      <Plate>BR Clear</Plate>                  <!-- "BR Clear" | "BR White" -->
      <Security>2|07/23/2026 21:26:16|System.CurrentSystemTimeZone|Bio-Rad Service|Bio-Rad Service||BioRadCFXManager|3.1.1517.0823|4ad03850-…</Security>
      <Channels>6</Channels>
      <Wells>108</Wells>
      <Factory>False</Factory>
      <PRs><PRs V="1">
        <dye0_x003A_20_x003A_PR><PlateRead V="1">…</PlateRead></dye0_x003A_20_x003A_PR>
        <empty0_x003A_20_x003A_PR>…</empty0_x003A_20_x003A_PR>
        <dye0_x003A_40_x003A_PR>…  <empty0_x003A_40_x003A_PR>…
        <dye0_x003A_60_x003A_PR>…  <empty0_x003A_60_x003A_PR>…
        <dye0_x003A_80_x003A_PR>…  <empty0_x003A_80_x003A_PR>…
      </PRs></PRs>
    </CalibrationData></I>
    …                                          <!-- 28 total: 14 dyes × {BR Clear, BR White} -->
  </Ar></UserCals>
```

**`Fluors`** is the shared dye library (one entry per dye the instrument knows, not per
calibration file) — `Name` matches a `CalibrationData`'s `<Dye>`, and `Channel` is the same
0-based primary-channel mapping `dcal.md` §6 documents from the binary format's (1-based)
`PRIMARYCHANNEL`.

**`FactoryCals`**/**`UserCals`** each hold an `<Ar>` of `<I><CalibrationData V="1">` — one per
(dye, plate type) pair, 28 total in the sample (all under `UserCals`; `FactoryCals` was empty).
`Dye` + `Plate` identify it exactly like a binary `.Dcal`'s `DYE`/`PLATE` fields; `Channels`/
`Wells`/`Factory`/`Notes` likewise match their binary-field namesakes directly.

**`Security`** flattens the binary format's separate `SECURITY{YEAR..APPVER}` fields into one
`|`-separated string: `<unknown>|MM/DD/YYYY HH:MM:SS|<.NET timezone type name>|username|
fullName|signature|app|appVersion|<guid>`. The timezone field is a serialized .NET type name
(`System.CurrentSystemTimeZone`), not a numeric offset, so there's no minutes-offset to recover
the way the binary `SECURITYTIMEZONE` int32 gives one. Interestingly, this date is often
*populated* here even when the matching `.zpcr`'s own binary `.Dcal` copy has an all-zero
`SECURITYYEAR` (unset) — the `.pcrd` snapshot can be the more complete of the two for this
field.

**`PRs`** doubly-wraps (`<PRs><PRs V="1">`) the eight payload blocks, keyed by the binary
format's own key names with colons XML-escaped by .NET's `XmlConvert.EncodeName`
(`dye0:20:PR` → `dye0_x003A_20_x003A_PR`) — lowercase `dye`/`empty` here, vs. the binary
format's `Dye`/`Empty`. Each block's value is a full `<PlateRead V="1">` element reusing
§2.1/§2.2's own schema (`Hdr/PlateReadDataHeader`, `Data/PAr`) — except here `Data/PAr` holds
**648 raw values** (`channels × wells`, one float per position, channel-major), not the 2592
`mean;std;min;max` tuples a real plate read's `PAr` carries — matching the binary `.Dcal`
payload block layout (`dcal.md` §3), not the `.Plateread` one. Every `AmbTmp`/`ShtTmp`/
`HeadSerNum`/`AlphaSerNum`/`BaseSerNum` inside each block's own header is a placeholder
(`0`/empty) in this sample — the instrument-side ambient/shuttle temperature and serials the
binary `.Dcal` carries at the top level aren't preserved in this XML form, so a `.pcrd`-derived
calibration reports those as absent rather than a fabricated `0`.

### 2.7 Provenance

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

## 3. Implementation notes

- The container needs no new code: the `.pltd` path (central-directory parse → ZipCrypto →
  inflate) applies unchanged. Only dispatch on the payload root element.
- With no password, do what `parsePltd` does — return the container with `needsPassword: true`
  rather than throwing.
- `PAr` parsing is the hot path: 45 × 2592 decimal floats, ~810 KB of text. Split on `;` and
  parse to a `Float32Array` shaped exactly like the binary `WELLDATA`, so a `.pcrd` and a
  `.zpcr` can feed the *same* `PlateRead[]` → `toCurves()` → `WellCurve[]` pipeline. The
  separator is a pure delimiter — no leading or trailing empty fields in any of the 45 reads.
- `calibrationCollection` is **56% of the document** (~1.4 MB serialized) — parsed only when
  `zpcr.calibrations()` is actually called (same lazy-getter shape as `plates()`/`protocols()`),
  so a caller that never touches calibration data never pays for walking it.
- A `.pcrd` is a superset of its `.zpcr` for everything except the `.Dcal`/`.alf` raw files, so
  it is the better input where both exist — and the only input carrying analysis state.
