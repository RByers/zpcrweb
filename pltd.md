# Bio-Rad CFX `.pltd` Plate-Definition File Format

Reverse-engineered from the `.pltd` files bundled inside `.zpcr` archives produced by a
Bio-Rad CFX96 (`CT019138`). A `.pltd` describes a **plate setup**: which fluorophores are
loaded in each of the 96 wells, the per-fluor target/gene, the sample name/condition, the
sample type, replicate number and — for standards — a quantity.

> **Status:** fully decoded. Every `.pltd` in the sample set (32 distinct files, 2019–2023,
> both container variants) decrypts, decompresses and parses; the decoded XML is byte-exact
> against a reference `unzip`. See [`packages/core/src/pltd.ts`](./packages/core/src/pltd.ts).

The library entry point is `parsePltd(bytes)` → `Pltd`, and `zpcr.plates()` decodes every
`.pltd` entry in an archive. The closely related `.prcl` protocol files use the **same
container** (§1–2) but carry a protocol payload instead of `<platesetup2>`.

---

## 1. Container — a single-entry ZIP

A `.pltd` is an ordinary ZIP archive containing exactly **one** entry, which is the "real"
plate file (its name echoes the `.pltd`, or is a GUID for files authored later). That entry
is **compressed and ZipCrypto-encrypted**. Two variants appear in the wild; parse via the
**central directory** (authoritative for both) rather than the local header:

| Variant | Leading bytes | GP flag | Method | Notes |
|---------|---------------|---------|--------|-------|
| A | `50 4B 03 04` (local header) | `0x0003` | **9 = Deflate64** | no data descriptor; CRC/size in local header |
| B | `50 4B 07 08` then `50 4B 03 04` | `0x000B` | **8 = Deflate** | leading spanning marker; data descriptor (bit 3); real CRC/size in the central directory |

- GP flag **bit 0 = 1** → the entry data is encrypted (ZipCrypto).
- The central-directory record (`50 4B 01 02`) gives the true `method`, `crc32`,
  `compressedSize`, `uncompressedSize`, filename and local-header offset. Local-header
  offsets are absolute from byte 0 (they already account for the leading spanning marker in
  variant B).
- `version-made-by = 45` and a UTF-16 filename stored in an extra field are consistent
  fingerprints of the writer's ZIP library.

The uncompressed inner file is small but highly repetitive (compression ratios up to ~54×),
so **Deflate64** (method 9) is common — a standard DEFLATE inflater cannot read those; the
library ships its own inflater ([`inflate.ts`](./packages/core/src/inflate.ts)) covering
both methods.

## 2. Encryption — traditional PKWARE (ZipCrypto)

The single entry is encrypted with the legacy PKWARE stream cipher (APPNOTE §6.1): three
32-bit keys seeded from a password, a 12-byte encryption header prepended to the entry, then
the compressed bytes. Standard-mode (non–Security-Edition) plate/protocol files all use one
**fixed password** (Security-Edition files use a per-user password instead).

### This project does not ship the password

To decode a file you must supply the password yourself:

- **Library:** `parsePltd(bytes, { password })` — with no password, an encrypted entry is
  returned as `{ container, needsPassword: true }` and nothing is decrypted.
- **Web app:** the first time you open a `.pltd`, it prompts for the password and stores it in
  your browser (`localStorage`, key `zpcr:pltdPassword`), reusing it for every plate
  thereafter.

### Finding the password (licensed CFX Manager only)

The fixed standard-mode password is a constant inside the CFX Manager software you already
license. In a legitimate installation you can recover it from the program's managed
assemblies: the value is the string handed to the bundled ZIP component's *default
encryption/decryption password* property (search the assemblies for the
`DefaultEncryptionPassword` / `DefaultDecryptionPassword` setters — the literal loaded
immediately before the call is the password). Enter that value into the app once. Do not
redistribute it.

Once supplied: decrypt the entry, drop the 12-byte header, then inflate (method 8 or 9). See
[`zipcrypto.ts`](./packages/core/src/zipcrypto.ts).

## 3. Payload — the `<platesetup2>` XML

Decrypted and inflated, the entry is a UTF-8 (BOM-prefixed) XML document rooted at
`<platesetup2>`:

```
<platesetup2 rows="8" columns="12" dyes="5" standardUnits="copy number"
             plateType="OtherStdTemplate" scanMode="AllChannelsScan" plateName="BR Clear" …>
  <identifier identityKey="…"/>
  <header … createdDate modifiedDate createdByClientApp guid …/>   <!-- provenance metadata -->
  <geneNameList>          <!-- the TARGETS -->
    <geneName shortName="DNA" fullName="DNA" geneColor="-16777011" …/>
  </geneNameList>
  <conditionNameList>     <!-- the SAMPLES / conditions -->
    <conditionName shortName="Std 0" fullName="Std 0" geneColor="…"/>
  </conditionNameList>
  <dyeLayersList>         <!-- one <dyeLayer> per FLUOROPHORE -->
    <dyeLayer plateName="FAM" RowsCount="8" ColumnsCount="12">
      <fluor fluorId="9" fluorName="FAM" channelPosition="0" fluorColor="…" units=""/>
      <wellSamples>       <!-- one <wellSample> per well, plateIndex 0..95 row-major -->
        <wellSample sampleId="" replicateNumber="-1" sampleQuantity="NaN"
                    wellSampleType="wcSample" plateIndex="0" wellLoadedFluor="True"
                    geneName="DNA" conditionName="Std 0" condition2Name="1:10"/>
        …
      </wellSamples>
    </dyeLayer>
    …                     <!-- repeated per dye; multi-dye plates have one layer each -->
  </dyeLayersList>
  <analysisSets> <wellGroup wellGroupName="All Wells" wellGroupMembers="0,1,2,…"/> </analysisSets>
  <TraceStyles>…</TraceStyles>
  <ExcludeSampleTypes exclude="1;0;0;0;0"/>
</platesetup2>
```

### Dye layers → fluorophores

There is **one `<dyeLayer>` per fluorophore**, in channel order. Its `<fluor>` gives the
name (`fluorName`, an open string set — e.g. FAM, SYBR, HEX, Texas Red, Cy5, Quasar 705, …)
and the 0-based optical channel (`channelPosition`). A well's loaded fluorophores are the
layers whose `<wellSample>` for that `plateIndex` has `wellLoadedFluor="True"`.

### Per-well fields (`<wellSample>`)

`plateIndex` is 0-based, row-major (`row*columns + col`). Fields:

| Attribute | Meaning |
|-----------|---------|
| `wellLoadedFluor` | `True` if **this** dye is loaded in the well. |
| `geneName` | **Target** for this well **+ this fluor** (per-layer). |
| `sampleId` | **Sample name** (often empty; see `conditionName`). |
| `conditionName`, `condition2Name` | Biological condition/group labels (e.g. `Std 0`, `1:200K`). |
| `wellSampleType` | Sample type — see enum below. |
| `replicateNumber` | Replicate; `-1` = unset. |
| `sampleQuantity` | Standard concentration; `NaN` = unset (standards may also use `condition*` dilution labels). |

A well is **loaded** iff at least one dye layer sets `wellLoadedFluor="True"`; otherwise it is
an empty tube.

### Sample-type enum (`wellSampleType`)

| Code | Meaning | Normalized |
|------|---------|------------|
| `wcSample` | Unknown | `unknown` |
| `wcStandard` | Standard (has quantity) | `standard` |
| `wcNTC` | No-template control | `ntc` |
| `wcNRT` | No-reverse-transcriptase control | `nrt` |
| `wcPostiveControl` | Positive control (Bio-Rad's spelling) | `positiveControl` |
| `wcNegativeControl` | Negative control | `negativeControl` |
| `wcEmpty` / `wcBlank` | Empty / not loaded | `empty` |
| `wcPassiveRef` | Passive reference | `passiveRef` |
| `wcCustom` | Custom | `custom` |

(`wcFirst`/`wcLast` are enum bounds and appear as filler in some files.)

---

## 4. Typed model

`parsePltd()` returns the container metadata plus a `PlateDefinition` with `fluors` (dye
layers), `targets`, `conditions`, and `wells[]` — each `WellDefinition` carrying its loaded
`fluors` (with per-fluor `target`), `sampleType`, `sampleName`, `condition(s)`, `replicate`
and `quantity`. On a wrong/missing password the container is still returned with an `error`
so callers can fall back to a raw hex view. The web app's **Raw files → Plate setup** panel
renders both a colour-coded plate map and the pretty-printed decrypted XML.
