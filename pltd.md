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
container** ([`zipcrypto.md`](./zipcrypto.md)) but carry a protocol payload instead of
`<platesetup2>`.

---

## 1. Container and encryption

A `.pltd` is a single-entry, ZipCrypto-encrypted ZIP — the same container format used by
`.pcrd`. See [`zipcrypto.md`](./zipcrypto.md) for the container variants, the central-directory
parse, the fixed shared password and how to recover it, and the decrypt → inflate pipeline.

## 2. Payload — the `<platesetup2>` XML

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

### Vessel type (white vs. clear) — `plateName`

**The tube/plate type lives in the root element's `plateName` attribute.** Despite its name it is
not a user-chosen label for the file — that is `header/@name` — but the **type of plastic the
reaction sits in**, chosen from a fixed list. Both committed samples carry one:
`BR White` in the 2019 `.zpcr`'s plate, `BR Clear` in the `.pcrd` sample.

Observed values, and the complete set the software recognizes:

| Value | Meaning |
|---|---|
| `BR Clear` | Bio-Rad clear-plastic plate/tubes |
| `BR White` | Bio-Rad white-plastic plate/tubes |
| `MJ White` | Legacy MJ Research white vessel — the default for plates originating in the older MJ-lineage path (see the iQ5 lineage note in §1) |

Across the plate files available for inspection the distribution is roughly two-thirds
`BR White`, one-third `BR Clear`, with a single `MJ White`.

**Why it matters:** white and clear plastic differ in reflectivity and background fluorescence, so
each has its **own pure-dye calibration**. This attribute is the join key into that calibration
data — `.Dcal` files carry a matching plate field using **the same strings** (see
[`dcal.md`](./dcal.md) §2, `PLATE`), and every `.zpcr` ships its calibration set covering both
plate types. Effectively, `plateName` selects which half of the archive's calibration data
applies, and therefore which dyes have usable calibration at all. Colour separation
([`calibration.md`](./calibration.md)) is only meaningful against the calibration for the plate
type the run actually used.

Three traps worth knowing:

- **`plateName` is reused on `<dyeLayer>` with an entirely different meaning** — there it holds the
  *fluorophore* name (`<dyeLayer plateName="SYBR" …>`), not a vessel type. Only the attribute on
  the **root element** is the plate type. This is why the parser reads the dye layer's name from
  `fluorName` where possible and treats the layer's `plateName` only as a fallback.
- **Compare case-insensitively.** The software carries both display-cased (`BR White`) and
  upper-cased (`BR WHITE`) forms of these names, and the shipped calibration files are
  inconsistent in the same way. Matching a plate to its calibration on an exact-case comparison
  will silently fail on some inputs.
- **`plateName` is not `plateType`.** The neighbouring `plateType` attribute is the *template
  category* (`OtherStdTemplate` in every file inspected) and says nothing about the vessel. The
  software separately models a vessel *form* — unassigned / plates / strips / tubes — but that is
  internal collection metadata and is **not** what this attribute holds; the white/clear
  distinction is carried by the string above and nothing else.

One cross-format note: the `.pcrd` document embeds this same schema but spells the root element
`<plateSetup2>` (capital S) where a `.pltd` uses `<platesetup2>`. The attribute is `plateName` in
both. Match the element name case-insensitively if one code path handles both.

### Plate identity — `identifier/@identityKey`

The root element's first child, `<identifier identityKey="…"/>`, carries the plate setup's own
identity — typically the source `.pltd` file name it was created/last saved from (e.g.
`Qualification_Plate_96.pltd`), or, for a plate authored inline in a saved experiment, that
experiment's own file name (e.g. `FirstExperiment.pltd` inside a `.pcrd`'s embedded
`<plateSetup2>`). **This, not `plateName`, is the closest thing to a user-facing plate name** —
`plateName` is a vessel/plastic type (see above), never an identity, despite the similar-looking
attribute names. `parsePlatesetup2` exposes this as `PlateDefinition.identityKey` (`undefined`
when the element is absent). Present and populated in every sample inspected, `.pltd` and `.pcrd`
alike.

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

## 3. Typed model

`parsePltd()` returns the container metadata plus a `PlateDefinition` with `fluors` (dye
layers), `targets`, `conditions`, and `wells[]` — each `WellDefinition` carrying its loaded
`fluors` (with per-fluor `target`), `sampleType`, `sampleName`, `condition(s)`, `replicate`
and `quantity`. The vessel type is exposed as `PlateDefinition.plateName` (§2) — the value to
match against a `.Dcal`'s plate field when selecting calibration — and the plate's own
user-facing identity as `PlateDefinition.identityKey` (§2). On a wrong/missing password the
container is still returned with an `error` so callers can fall back to a raw hex view. The web
app's **Raw files → Plate setup** panel renders both a colour-coded plate map and the
pretty-printed decrypted XML.
