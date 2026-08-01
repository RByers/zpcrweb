# The protocol language

## 1. The problem

A run is defined by a short program:

```
METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 95.0,10;TEMP 60.0,30;
PLATEREAD #h3F;GOTO 2,44;END;
```

Eight directives, and every one of them matters to what the experiment is: whether the lid is
heated, how long the denature step holds, which optical channels get read, how many cycles run.
None of that is legible from the text alone. `GOTO 2,44` is the extreme case — it names a step by
a number that appears nowhere in the program, and the count it carries is one less than the number
of cycles the run performs.

This document defines the language: every verb, its operands, and what the instrument does with
them. It is the semantic layer over three file formats that all carry the same text
(§2), and it is what lets an app show a protocol as something a person can read rather than a
string it happened to store.

**Implemented by `packages/core/src/runDefinition.ts`**, entry point `parseRunDefinition(text)`,
which returns typed directives carrying their operands, their step number (§4) and a one-line
description. The web app renders those descriptions beside the directives and does no parsing of
its own — `apps/web/src/components/raw/DecodedView.tsx`.

This is a *semantics* doc, not a file-format doc: how the text is stored, encrypted and framed
belongs to `prcl.md` (files) and `usb.md` (the wire).

## 2. Where the text comes from

Four sources carry the identical grammar:

| Source | What it is | Trust |
|---|---|---|
| `ProtocolRunDefinition.txt` in a `.zpcr` | what the instrument recorded for the run it actually performed | **canonical for a run** |
| `protocol2`'s `runDefinition` attribute in a `.prcl` or `.pcrd` | the protocol as authored in CFX Manager | canonical for the *design*, not the run |
| a plaintext `.prcl` (`prcl.md` §1.1) and this project's `.prcl.txt` (`prcl.md` §3.1) | a protocol on its own, outside any run | as written |
| the USB command channel (`usb.md` §3) | the same verbs, sent one per frame, to author a protocol on the instrument | live |

The authored and recorded forms of one run are **not** byte-identical: the `PLATEREAD` operand
differs (§5) and the terminator differs. `prcl.md` §3 tabulates both differences; don't diff the
two literally.

An authored `.prcl` also carries the protocol a second time as a structured XML step list
(`prcl.md` §2), which is a *lossy* re-statement of the text: it collapses a melt curve's four text
directives into one `MeltCurveStep` and numbers steps differently (§4). The text is the form that
survives everywhere, so it is the one this library decodes for meaning; `describeProtocolStep()`
gives the XML step list the same treatment where a file has one.

## 3. The verbs

Directives are separated by `;`, whitespace is insignificant, and operands are separated by `,`.
The first three verbs are a setup header; the rest are the step list, terminated by `END`.

| Directive | Operands | What it does |
|---|---|---|
| `METHOD <name>` | `CALC` | Thermal control method. `CALC` controls the *calculated sample* temperature — the instrument's model of what is in the well — rather than the block itself. `BLOCK`, the other mode, controls block temperature directly; it appears in the instrument's idle `STATUS?` response (`usb.md` §3) but in no protocol seen here |
| `HOTLID <temp>,<shutoff>` | °C, °C | Heated lid setpoint, and the block temperature below which the lid heater turns off. Mirrors the XML's `lidTemperature` / `shutoffTemperature` (`prcl.md` §3); the pair `105,30` is CFX Manager's default |
| `VOLUME <µL>` | µL | Sample volume. Not a dispensing instruction — it feeds the thermal model that `METHOD CALC` uses to infer sample temperature from block temperature |
| `TEMP <°C>,<seconds>` | °C, s | Hold one temperature for a fixed time. A hold of `0` seconds is an **indefinite** hold — the shipped `BurnIn.prcl` ends on `TEMP 12.0,0`, an infinite chill (§6) |
| `GRAD <low>,<high>,<seconds>` | °C, °C, s | Hold a temperature *gradient* across the block's rows — low temperature at one edge, high at the other, so one plate tests a range of annealing temperatures at once |
| `INC <°C>` | °C | Add this much to the preceding step's target on each pass through the loop. This is what turns a `TEMP` inside a `GOTO` loop into a melt-curve ramp |
| `RATE <°C/s>` | °C/s | Ramp rate toward the preceding step's target |
| `PLATEREAD #h<hex>` | scan mask | Read the plate — the optical measurement that makes the run real-time. The operand says which channels and how the head sweeps: §5 |
| `GOTO <step>,<repeats>` | step number, count | Jump back to step `<step>` (§4) and run from there again, `<repeats>` more times. The loop body executes **`repeats + 1`** times in total, so a 45-cycle PCR reads `GOTO 2,44` |
| `END` | — | Ends the step list |

A verb outside this inventory is not silently dropped: `parseRunDefinition` keeps it as an
`UNKNOWN` directive and lists it in `unknownVerbs`, while `parseRunDefinitionText` — the strict
door, used when a user picks a file off disk — rejects the whole text, which is how "you chose
the wrong file" gets reported (`prcl.md` §3.1).

## 4. Step numbers

`GOTO`'s target is a **1-based index over the step list**: every directive except the
`METHOD`/`HOTLID`/`VOLUME` header and the `END` terminator counts as a step, including
`PLATEREAD`, `INC` and `RATE`.

```
METHOD CALC;        —          HOTLID 105,30;      —          VOLUME 20;      —
TEMP 95.0,60;       step 1     TEMP 95.0,10;       step 2     TEMP 60.0,30;   step 3
PLATEREAD #h3F;     step 4     GOTO 2,44;          step 5     END;            —
```

So `GOTO 2,44` returns to `TEMP 95.0,10` and the run performs 45 cycles of steps 2–4.

That `PLATEREAD` and the modifiers count is measured, not assumed — see Appendix A, where a melt
protocol's `GOTO 7,7` resolves correctly only under this rule.

⚠️ **This is not the XML step list's numbering.** The XML numbers from 0, folds `PLATEREAD` into
the step it follows (as a nested `PlateReadOption`), and folds a melt's `TEMP`/`INC`/`RATE` group
into a single `MeltCurveStep` — so the same loop is `GOTO 3,39` in the text and
`optionGotoStep="2"` in the XML (`prcl.md` §3). Both numberings are exposed, each on its own
representation: `RunDefinitionDirective.stepNumber` for the text, `ProtocolStep.stepNumber` for
the XML. Never mix them.

## 5. `PLATEREAD`'s scan mask

The operand is one byte holding two fields — bits 0–5 select optical channels 1–6, bit 7 picks
step-and-repeat (clear) vs. flyover (set) — so `#h3F` is "all six channels, stopping over each
well" and `#h81` is "channel 1 only, scanning continuously", the fast SYBR/FAM configuration.
Decoded by `parseScanMask()`; the full decoding, the evidence, and the instrument's three
independent echoes of the same value are in **`usb.md` §3.1**.

The one thing to carry over here: **an authored protocol's operand is not a channel selection.**
CFX Manager writes `#h3F` into every `.prcl` regardless of what the run will measure, and the real
mask is substituted from the plate definition's `scanMode` when the run starts. So `#h3F` in a
`.prcl` means "unspecified". Preserve the operand as recorded rather than recomputing one.

The same byte layout is what a `.Plateread`'s `CHANNELMASK` carries (`plateread.md` §4) and what
`RunInfo.xml` records in decimal as `ScanMask`, which is why one decoder serves all three
(`pivot.ts`'s `toChannels` reads the same function).

## 6. What we don't know

- **`HOTLID`'s second operand.** Read here as the lid *shutoff* temperature, because the XML form
  of the same protocol carries `lidTemperature="105" shutoffTemperature="30"` against a text
  `HOTLID 105,30` — a match on both numbers, in order. `usb.md` §3's command table calls it a ramp
  rate, which was a guess made from the wire alone before the file-side correspondence was
  available. The value is `30` in every file and capture seen, so no observation separates the two
  readings beyond that correspondence.
- **`INC` vs. `RATE`.** Both appear only in melt-curve loops, and in every sample they carry the
  *same* number (`INC 0.5;RATE 0.5` and `INC 5.0;RATE 5.0`). The reading here — increment per pass
  vs. ramp rate — comes from `prcl.md` §3's inventory and from the XML, which has a
  `meltCurveTemperatureIncrement` matching `INC` and nothing matching `RATE`. Whether CFX Manager
  can emit a `RATE` that differs from the `INC` beside it is untested.
- **A zero hold.** `TEMP 12.0,0` is read as an indefinite hold, which is how a CFX post-run chill
  behaves and what "0 seconds" would otherwise have to mean (a step that does nothing). Not
  confirmed against firmware or a live run.
- **`METHOD`'s other values.** `CALC` is the only one in any file here. `BLOCK` is inferred from
  the idle `STATUS?` response's `"",BLOCK,OFF` field (`usb.md` §3), not from a protocol.
- **Verbs the grammar has that no file uses.** The inventory in §3 is the union of everything seen
  across the committed samples and the two USB captures. The instrument's ASCII channel accepts at
  least `ADDCYCLES` (`usb.md` §3), which no stored protocol contains; there may be more.
- **Whether `INC`/`RATE` bind to the preceding step or the enclosing loop.** They are written
  after the step they modify and are treated as modifying it. No file places one anywhere else, so
  the alternative — that they set a mode for everything that follows — is untested.

## Appendix A: how the step numbering was measured

Two committed samples carry both the text form and the XML step list for the same protocol, which
makes the text's `GOTO` target checkable against the XML's.

**`samples/20260720_Luna_noRT.pcrd`** — a plain cycling protocol:

```
METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 95.0,10;TEMP 60.0,30;PLATEREAD #h3F;GOTO 2,44;END;
```

Its XML has `optionGotoStep="1"` (0-based) → `temperatureStepNumber="1"` = `TEMP 95.0,10`. The
text's `GOTO 2` picks the same step under the §4 rule. This case alone doesn't settle whether
`PLATEREAD` counts, because the only `PLATEREAD` sits *after* the target.

**`samples/Short Qualification_Plate_96.prcl.xml`** — a cycling loop followed by a melt, which
does settle it:

```
METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 98.0,10;TEMP 98.0,5;TEMP 57.5,10;
PLATEREAD #h3F;GOTO 2,1;TEMP 56.5,31;TEMP 56.5,5;INC 5.0;RATE 5.0;PLATEREAD #h3F;GOTO 7,7;END;
```

Numbering every non-header directive puts step 7 on `TEMP 56.5,5` — the melt's per-pass hold, and
the only sensible target for the loop that `INC 5.0` ramps. The alternatives fail outright:

| Rule | Step 7 lands on | Verdict |
|---|---|---|
| every directive except the header and `END` | `TEMP 56.5,5` | ✅ the melt body |
| skip `PLATEREAD` | `INC 5.0` | ❌ a modifier, not a step |
| skip `PLATEREAD`, `INC`, `RATE` | — | ❌ only 5 steps exist |
| count thermal steps only (`TEMP`/`GRAD`) | — | ❌ only 5 steps exist |

The second `GOTO`'s repeat count corroborates the reading: `GOTO 7,7` is 8 passes at `+5.0` °C
each, i.e. 56.5 °C → 91.5 °C, and the XML records exactly `meltCurveEndTemp="91.5"`.

Both cases are asserted in `packages/core/test/runDefinition.test.ts`.
