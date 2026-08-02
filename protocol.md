# The protocol language

## 1. The problem

A run is defined by a short program:

```
METHOD CALC;HOTLID 105,30;VOLUME 20;TEMP 95.0,60;TEMP 95.0,10;TEMP 60.0,30;
PLATEREAD #h3F;GOTO 2,44;END;
```

Nine directives, and every one of them matters to what the experiment is: whether the lid is
heated, how long the denature step holds, which optical channels get read, how many cycles run.
None of that is legible from the text alone. `GOTO 2,44` is the extreme case — it names a step by
a number that appears nowhere in the program, the count it carries is one less than the number of
cycles the run performs, and the numbering it counts in skips some directives and not others.

This document defines the language: every verb, its operands, what the instrument does with them,
and what a `GOTO` target means. It is the semantic layer over the five carriers that all hold the
same text (§2), and it is what lets an app show a protocol as something a person can read rather
than a string it happened to store.

**Implemented by `packages/core/src/runDefinition.ts`**, entry point `parseRunDefinition(text)`,
which returns typed directives carrying their operands, their step number (§4) and a one-line
description. The web app renders those descriptions beside the directives and does no parsing of
its own — `apps/web/src/components/raw/DecodedView.tsx`.

This is a *semantics* doc, not a file-format doc: how the text is stored, encrypted and framed
belongs to `prcl.md` (files) and `usb.md` (the wire).

**A note on provenance.** Rules below are marked **measured** (derived from a committed sample or
a USB capture, with the evidence named), or **stated** (part of the language's own definition,
with no sample here that exercises it — §3.5's limits are mostly this). The distinction is what
tells a reader which numbers are safe to change: a measured rule is load-bearing for files that
exist, a stated one is a guard rail nothing here has pushed against.

## 2. Where the text comes from

Five carriers hold the identical grammar:

| Carrier | What it is | Trust |
|---|---|---|
| `ProtocolRunDefinition.txt` in a `.zpcr` | what the instrument recorded for the run it actually performed | **canonical for a run** |
| the `.alf` run report in a `.zpcr` ([`alf.md`](./alf.md)) | the same text again, `*`-delimited instead of `;`-delimited, followed by the instrument's step-by-step execution log (§4, Appendix A) | canonical, and the only carrier that says what *ran* |
| `protocol2`'s `runDefinition` attribute in a `.prcl` or `.pcrd` | the protocol as authored | canonical for the *design*, not the run |
| a plaintext `.prcl` (`prcl.md` §1.1) and this project's `.prcl.txt` (`prcl.md` §3.1) | a protocol on its own, outside any run | as written |
| the USB command channel (`usb.md` §3) | the same verbs, one per command frame, authoring a protocol on the instrument | live (§7) |

They are **not** byte-identical to each other. §8 tabulates every difference seen; the two that
bite are that an authored file's `PLATEREAD` operand is not the one the run used (§5) and that the
delimiter and terminator vary by carrier (§8).

An authored `.prcl` also carries the protocol a second time as a structured XML step list
(`prcl.md` §2), which is a *lossy* re-statement of the text: it collapses a melt curve's six text
directives into one `MeltCurveStep` (§6) and numbers steps differently (§4). The text is the form
that survives everywhere, so it is the one this library decodes for meaning;
`describeProtocolStep()` gives the XML step list the same treatment where a file has one.

## 3. The grammar

### 3.1 Shape of a program

```
<header> <step>* END
```

Directives are separated by `;`, whitespace between them is insignificant, and a directive's
operands are separated by `,`. Verbs are case-insensitive; every carrier here writes them upper
case.

- The **header** is `METHOD`, `HOTLID`, `VOLUME`, in that order, and describes the run as a whole.
  All three are **always present**: the header is fixed-arity, not a set of optional settings —
  see below.
- The **step list** is the rest. Each step is one thermal or optical action, optionally followed by
  **modifiers** that attach to it.
- `END` terminates. Everything after it is ignored.

**The header is never elided.** A protocol with the lid heater turned off still writes `HOTLID`,
and a protocol whose method needs no volume model still writes `VOLUME`. Off and unused are said
with a `0` operand, never by omitting the directive. In CFX Manager's writer
(`Protocol2.ToRunDefinition()`, `BioRad.WinCE.PCR.InstrumentData`) the output array is sized
`steps + 4` and slots 0, 1, 2 are filled unconditionally with `METHOD`, `HOTLID`, `VOLUME` — there
is no branch anywhere in it that skips one. Concretely:

| Authored as | Emitted |
|---|---|
| lid heater on, default temperature | `HOTLID 105,30` |
| lid heater on, user temperature *T* | `HOTLID <T>,30` |
| **lid heater off** ("Turn lid off" in the lid dialog) | `HOTLID 0,30` — emitted, with a `0` setpoint |
| sample volume *V* µL (thermal model in use) | `METHOD CALC` + `VOLUME <V>` |
| **no volume model** (block-temperature control) | `METHOD BLOCK` + `VOLUME 0` — emitted, with a `0` volume |

Three details of that writer are worth carrying into any encoder:

- **The lid-off flag zeroes the setpoint, not the directive.** The dialog's three-way choice
  (`ProtocolLidSettingsForm`: default / user-specified / turn off) collapses to
  `lidTemp = useDefault ? 105 : userTemp`, then `if (shutoffLidEnabled) lidTemp = 0`, applied
  immediately before formatting. The **second** operand is untouched by the choice and keeps its
  own value — `ProtocolConstants.c_ShutoffLidTemperature`, `30`, in everything seen — so lid-off
  is `HOTLID 0,30` and not `HOTLID 0,0`.
- **"Default" always writes 105**, even on a 48- or 384-well block. The writer hardcodes
  `c_DefaultLidTemperature96` for the default case, although `c_DefaultLidTemperature48` (100) and
  `c_DefaultLidTemperature384` (95) exist and the lid dialog displays them. A `105` in the text
  therefore does not prove the run was on a 96-well block.
- **`METHOD` is derived from `VOLUME`, not chosen independently**: `volume == 0 → BLOCK`,
  otherwise `CALC` (`ProtocolConstants.c_VolumeForBlockMethod` is `0`). The two header fields
  cannot disagree in generated text, and `METHOD OTHER` — which `Protocol2.Method` can return
  in-memory for an unassigned volume of `−1` — is never written into a run definition.

The **reader** is more forgiving than the writer, in both implementations. CFX Manager's
`Protocol2.UnserilizeRunDefinition()` is a `switch` over whatever directives appear; a text missing
`HOTLID` or `VOLUME` parses fine and simply leaves the object's defaults standing (which, for a
missing `VOLUME`, silently means `0`/`BLOCK`). `parseRunDefinition` matches that tolerance without
inheriting the trap: a missing header directive yields `null` for `lidTemperatureC`,
`shutoffTemperatureC`, `volumeUl` or `method`, distinguishable from a `0` that was really written.
`ProtocolBuilder.toRunDefinition()` emits all three unconditionally, as CFX does.

**Provenance.** `HOTLID 105,30` with a non-zero `VOLUME` is **measured**: every header in
`samples/` is `METHOD CALC;HOTLID 105,30;VOLUME 20` (5 occurrences), the package fixtures and
capture-derived tests add `VOLUME 25`, and all of them carry all three directives — as does every
run definition hardcoded in CFX Manager's own `EstimatedTimeToComplete` self-tests. The lid-off
and `VOLUME 0` rows are **stated**: they come from the decompiled writer above, and the only
`METHOD BLOCK;HOTLID 0,30;VOLUME 0` in the tree is one this project's own builder constructs in
`packages/core/test/protocolBuilder.test.ts`. No sample here was authored with the lid off, so the
claim being relied on is the negative one — that no code path omits the directive — which the
writer's structure establishes directly.

Four directive roles, and the difference between them is what §4's numbering turns on:

| Role | Verbs | Numbered? |
|---|---|---|
| Header | `METHOD`, `HOTLID`, `VOLUME` | no |
| Step | `TEMP`, `GRAD`, `MELT`, `PLATEREAD`, `GOTO` | **yes** |
| Modifier | `INC`, `RATE`, `EXT`, `BEEP` | no — they modify the step they follow |
| Terminator | `END` | no |

### 3.2 The verbs

| Directive | Operands | What it does |
|---|---|---|
| `METHOD <name>` | `CALC` \| `BLOCK` \| `OTHER` | Thermal control method. `CALC` controls the *calculated sample* temperature — the instrument's model of what is in the well, driven by `VOLUME` — rather than the block itself. `BLOCK` controls block temperature directly and goes with `VOLUME 0`. `OTHER` is defined by the language but appears in no file or capture here |
| `HOTLID <temp>,<shutoff>` | °C, °C | Heated-lid setpoint, and the block temperature below which the lid heater turns off. `<temp>` of `0` disables lid heating altogether — **a disabled lid is `HOTLID 0,30`, not a missing `HOTLID`** (§3.1). The pair `105,30` is the writer's default and is what every sample here carries |
| `VOLUME <µL>` | µL | Sample volume. Not a dispensing instruction — it feeds the thermal model `METHOD CALC` uses to infer sample temperature from block temperature. `0` means "no model", which is what `METHOD BLOCK` runs with — and **`VOLUME 0` is written out**, the directive is never dropped for a method that ignores it (§3.1) |
| `TEMP <°C>,<seconds>` | °C, s | Hold one temperature for a fixed time. A hold of `0` seconds is an **indefinite** hold — the shipped `BurnIn.prcl` ends on `TEMP 12.0,0`, an infinite chill |
| `GRAD <low>,<high>,<seconds>` | °C, °C, s | Hold a temperature *gradient* across the block's rows — low temperature at one edge, high at the other, so one plate tests a range of annealing temperatures at once |
| `MELT <start>,<end>,<increment>,<hold>,#h<mask>` | °C, °C, °C, s, scan mask | A whole melt curve as one directive. Every stored protocol here spells a melt out the long way instead (§6), so this compact form is **stated**, not measured |
| `PLATEREAD #h<hex>` | scan mask | Read the plate — the optical measurement that makes the run real-time. The operand says which channels and how the head sweeps: §5 |
| `GOTO <step>,<repeats>` | step number, count | Jump back to step `<step>` (§4) and run from there again, `<repeats>` more times. The loop body executes **`repeats + 1`** times in total, so a 45-cycle PCR reads `GOTO 2,44` |
| `INC <°C>` | °C | *Modifier.* Add this much to the preceding step's target on each pass through the enclosing loop. This is what turns a `TEMP` inside a `GOTO` loop into a melt-curve ramp. May be negative (ramp down) |
| `RATE <°C/s>` | °C/s | *Modifier.* Cap the ramp rate toward the preceding step's target |
| `EXT <seconds>` | s | *Modifier.* Lengthen the preceding step's hold by this much on each pass — the "extend" of a touchdown/extension protocol. May be negative, to shorten. Defined by the language; no sample here uses it |
| `BEEP` | — | *Modifier.* Sound the instrument's beeper when the preceding step completes. Defined by the language; no sample here uses it |
| `END` | — | Ends the step list |

**Modifiers may also ride inline**, as extra comma-separated operands of the step they modify:
`TEMP 95.0,10,INC 0.5,EXT 5` means the same as `TEMP 95.0,10;INC 0.5;EXT 5;`, and `GRAD` accepts a
trailing `EXT` the same way. Only `INC` and `EXT` have this second spelling. No file or capture
here uses it — `parseRunDefinition` accepts both because the language does, not because anything
observed needed it.

A verb outside this inventory is not silently dropped: `parseRunDefinition` keeps it as an
`UNKNOWN` directive and lists it in `unknownVerbs`, while `parseRunDefinitionText` — the strict
door, used when a user picks a file off disk — rejects the whole text, which is how "you chose
the wrong file" gets reported (`prcl.md` §3.1).

### 3.3 Operand formatting

| Operand | Written as | Example |
|---|---|---|
| Temperatures, increments, ramp rates | one decimal place, always — `#0.0` | `95.0`, `0.5`, `-10.0` |
| Times, volumes, lid temperatures, step and cycle counts | plain integers | `180`, `20`, `105` |
| Scan masks | `#h` then hex, unpadded (§5) | `#h3F`, `#h81` |
| Protocol names, over USB | single-quoted | `PROTOCOL 'PCRUN'` |

Two irregularities worth not tripping over. `GRAD`'s two temperatures are written `55.0,65.0` in
the protocol text but appear as `55;65` in the `.alf` execution log's temperature column — a
different rendering of the same step, not a different step. And `MELT`'s mask is written in
**lower**-case hex where `PLATEREAD`'s is upper (`#h3f` vs `#h3F`); readers should be
case-insensitive, which `parseScanMaskOperand` is.

### 3.4 What is a step's temperature, actually

`METHOD CALC` means the number in a `TEMP` directive is a *sample* temperature, not a block
temperature: the instrument runs its block to whatever the thermal model says will put the sample
at the target, given `VOLUME`. This is why a `.Plateread`'s recorded block temperature can differ
from the protocol's number for the step it was taken in, and why `VOLUME` is not cosmetic —
changing it changes the block trajectory for an unchanged protocol text.

### 3.5 Limits

Every value below is **stated** — the language's own bounds. Nothing in the committed samples
approaches most of them, so they are documented as a decoder's sanity guide, not as a measured
range.

| Operand | Range |
|---|---|
| Temperature (`TEMP`, `MELT`) | 0 – 100 °C |
| Gradient temperature / range (`GRAD`) | 30 – 100 °C, spread 1 – 24 °C |
| Hold time | 0 – 64800 s (18 h); `0` is the indefinite hold, and a melt's per-pass hold must be ≥ 1 |
| Lid temperature (`HOTLID`) | 0 – 110 °C, `0` = heater off |
| Volume (`VOLUME`) | 0 – 125 µL |
| Increment (`INC`) | −10.0 – +10.0 °C |
| Ramp rate (`RATE`) | 0.1 – 5.0 °C/s |
| Extend (`EXT`) | −60 – +60 s |
| `GOTO` repeats | 1 – 9999 |
| `GOTO` target step | 1 – 97 |
| Steps in a protocol | ≤ 98 |

`GRAD` steps take no `INC`, `RATE` or `BEEP` modifier — a gradient is already a spread across the
block, and the language does not allow it to also ramp.

## 4. Step numbers

`GOTO`'s target is a **1-based index over the step list**. Counting it correctly means knowing
which directives take a number:

- **Counted:** `TEMP`, `GRAD`, `MELT`, `PLATEREAD`, `GOTO`.
- **Not counted:** the `METHOD`/`HOTLID`/`VOLUME` header, the `END` terminator, and the four
  modifiers `INC`, `RATE`, `EXT`, `BEEP`.

```
METHOD CALC;        —          HOTLID 105,30;      —          VOLUME 20;      —
TEMP 95.0,60;       step 1     TEMP 95.0,10;       step 2     TEMP 60.0,30;   step 3
PLATEREAD #h3F;     step 4     GOTO 2,44;          step 5     END;            —
```

So `GOTO 2,44` returns to `TEMP 95.0,10` and the run performs 45 cycles of steps 2–4.

Both halves of the rule are **measured**, from the instrument's own accounts of its own runs
rather than inferred (Appendix A): the `.alf` execution log inside two committed samples numbers a
melt's plate read `8` rather than `10`, which is only true if `PLATEREAD` and `GOTO` are counted
and `INC`/`RATE` are not; and the live `STATUS?` response during a run reports the step number
beside the step text, giving `PLATEREAD #h3F` → `4` for the protocol above.

⚠️ **This is not the XML step list's numbering.** The XML numbers from 0, folds `PLATEREAD` into
the step it follows (as a nested `PlateReadOption`), and folds a melt's whole group into a single
`MeltCurveStep` — so the same loop is `GOTO 3,39` in the text and `optionGotoStep="2"` in the XML
(`prcl.md` §3). Both numberings are exposed, each on its own representation:
`RunDefinitionDirective.stepNumber` for the text, `ProtocolStep.stepNumber` for the XML. Never mix
them.

The correspondence between the two, where a file carries both, is that one XML step maps to one
*or more* consecutive text steps: a plain `TEMP` is one, a `TEMP` carrying a plate read is two, and
a `MeltCurveStep` is four (§6).

## 5. `PLATEREAD`'s scan mask

The operand is one byte holding two fields — bits 0–5 select optical channels 1–6, bit 7 picks
step-and-repeat (clear) vs. flyover (set) — so `#h3F` is "all six channels, stopping over each
well" and `#h81` is "channel 1 only, scanning continuously", the fast SYBR/FAM configuration.
Decoded by `parseScanMask()`; the full decoding, the evidence, and the instrument's three
independent echoes of the same value are in **`usb.md` §3.1**.

The one thing to carry over here: **an authored protocol's operand is not a channel selection.**
`#h3F` is written into every authored `.prcl` regardless of what the run will measure, and the
real mask is substituted from the plate definition's `scanMode` when the run starts. So `#h3F` in
a `.prcl` means "unspecified". Preserve the operand as recorded rather than recomputing one.

`MELT`'s fifth operand is the same byte with the same meaning (§3.3 notes only the hex casing
differs), and `parseRunDefinition` surfaces both through the same `scanMasks` list.

The same byte layout is what a `.Plateread`'s `CHANNELMASK` carries (`plateread.md` §4) and what
`RunInfo.xml` records in decimal as `ScanMask`, which is why one decoder serves all three
(`pivot.ts`'s `toChannels` reads the same function).

## 6. Melt curves

A melt curve is a `GOTO` loop whose body climbs: hold, read, raise the target, repeat. The
language can say that two ways, and every stored protocol here uses the long one:

```
TEMP 56.5,31;      ← equilibration hold, always exactly 31 s
TEMP 56.5,5;       ← the per-pass hold, at the melt start temperature
INC 5.0;           ← how much the hold's target climbs per pass
RATE 5.0;          ← ramp rate toward it
PLATEREAD #h3F;    ← read at every rung
GOTO 7,7;          ← back to the per-pass hold, 7 more times = 8 rungs
```

Six directives, occupying **four** step numbers (§4 — `INC` and `RATE` take none), which the XML
collapses into one `MeltCurveStep`. Four things about the group are worth knowing before touching
it:

- **The `31` is a marker, not a tuning parameter.** The first hold is 31 seconds in every melt in
  every carrier, and a group is recognized as a melt curve *because* its first hold is 31 s at the
  same temperature as its second. Change it and the group stops reading as a melt. (`prcl.md` §4
  listed this as an unexplained constant; it is one, but a load-bearing one.)
- **The end temperature is not stored.** It is `start + repeats × increment` — `56.5 + 7 × 5 =
  91.5` above, matching the XML's `meltCurveEndTemp="91.5"`. A reader parsing the text has to
  reconstruct it; one parsing the XML gets it directly.
- **`RATE` mirrors `INC` here.** In a melt the ramp rate is written as the increment's magnitude,
  clamped into the 0.1 – 5.0 °C/s range of §3.5 — which is why every sample shows `INC 0.5;RATE
  0.5` and `INC 5.0;RATE 5.0`. They are only forced equal *inside a melt*; on an ordinary step,
  `RATE` is an independent modifier.
- **`GOTO` targets the second hold**, not the 31-second one, so the equilibration happens once and
  the ramp happens every pass.

The compact `MELT` form (§3.2) says the same thing in one directive with the end temperature
explicit. No carrier here contains one.

## 7. Delivering a protocol over USB

The instrument does not read a `.prcl`. A protocol is **typed at it, one directive per command
frame**, over the ASCII command channel of `usb.md` §3, and the same grammar this document
describes is what goes on the wire — `usb.md` §5.1 has the evidence that the encrypted
`.prcl`/`.pltd` pair is a host-side concern the instrument never opens.

The session observed in the `usb-run` capture, in order:

```
PROTOCOL 'PCRUN'                              → 0000     name the protocol being authored
METHOD CALC                                   → 0000     the §3.1 header, one command each
HOTLID 105,30                                 → 0000
VOLUME 25                                     → 0000
TEMP 95.0,180                                 → 0000     the step list, one command each
TEMP 95.0,10                                  → 0000
TEMP 55.0,30                                  → 0000
PLATEREAD #h3F                                → 0000
GOTO 2,1                                      → 0000
END                                           → 0000
RemoteRun "A","True","False","singletest","admin","","True","CALC"   → 0000
PROCEED                                       → 0000     (3½ min later, mid-run — skips a step)
```

Three things this adds to the stored forms:

- **No delimiter.** Each directive is its own command, so the `;` that separates directives in a
  file has no analogue on the wire. `END` is a command like any other, not a terminator character.
- **Every directive is acknowledged individually** with the bare `0000` of `usb.md` §3 — a
  malformed step fails at the step, not at the end.
- **`RemoteRun` starts it** — on that command, with nothing further required — and carries what the
  protocol text cannot. Its eight positional operands are `<block>,<lid on>,<remote start>,<run
  name>,<user>,<sample ID>,<sierra mode>,<method>`, defined one by one in **`usb.md` §7.3**. Three
  of them are the ones a protocol file has no way to express: `<remote start>` chooses between
  starting now and staging the run for someone to start at the instrument's own touchscreen;
  `<sierra mode>` asks the instrument to run the protocol *and* its own optics autonomously, which
  is why a plate read needs no command from the host and why the results are simply files
  afterwards; and `<method>` repeats the `METHOD` of §3.2 — the copy `STATUS?` reports back. Note
  the run's name lives *here*, not in `PROTOCOL`, whose operand is a fixed placeholder. The first
  two are **stated** in this document's sense: the capture sends each with a single value and never
  varies it, so what the other value does is not measured here.
  The `PROCEED` above is *not* part of starting it: the run was already 3½ minutes in, and
  `PROCEED` skipped the rest of the step it was on (`usb.md` §7.5).

`ADDCYCLES <n>` extends the running protocol's loop after the fact; the capture sends `ADDCYCLES
0`, a no-op, as part of ordinary run setup. Everything else about run control — `PROCEED`,
`CANCEL`, `PAUSE`/`RESUME` — is instrument state, not protocol language, and lives in `usb.md` §3;
the full start-to-finish sequence a run is embedded in is `usb.md` §7.

> **Implemented.** `packages/core/src/usb/runPlan.ts` turns a run definition and a plate into
> exactly the command list above — `planRun()` — and `CfxDevice.startRun()` sends it (`usb.md`
> §10). The directive list the Instrument view displays is the same value that is transmitted, so
> what is reviewed on screen is character-for-character what is typed at the instrument.

## 8. Differences between the carriers

Every difference observed across the five carriers of §2, so nothing here gets diffed literally:

| | Directive separator | Terminator | `PLATEREAD` operand |
|---|---|---|---|
| `ProtocolRunDefinition.txt` | `;` | `END` or `END;`, then CRLF | the mask the run used |
| `.alf` run report | `*` | `END`, then CRLF | the mask the run used |
| `.prcl` / `.pcrd` `runDefinition` | `;` | `END;` | always `#h3F` (§5) |
| `.prcl.txt` (this project's) | `;` + newline | `END;` | as written |
| USB command channel | none — one command per directive | `END` command | the mask being requested |

Only one of these differences reaches `parseRunDefinition`, which reads the `;` form: `alf.ts`
re-delimits line 2 from `*` to `;` before handing it over (`alf.md` §5), so the run report is
decoded by the same grammar as every other carrier rather than by a second parser.

The terminator is the one that surprises: **`END` and `END;` both occur in recorded
`ProtocolRunDefinition.txt` files**, across the same instrument. Three of the five committed
samples end bare, two end with the semicolon; the `.alf` copy of the very same protocol ends bare
in all five. Treat the trailing `;` as optional on read and don't use it to tell carriers apart.
(`prcl.md` §3 describes the bare `END` as characteristic of the archive's `.txt`; that holds for
the older runs and not for the 2026 ones.)

## 9. What we don't know

- **Whether an arbitrary channel subset is accepted in a scan mask.** Only the two whole
  configurations `#h3F` and `#h81` have been observed, and the expected FRET encoding never
  appears. `usb.md` §3.1 and §9 carry this.
- **`EXT`, `BEEP`, `MELT` and `METHOD OTHER` are stated, not measured.** They are part of the
  language, but no committed sample and neither capture contains one, so their operand handling is
  documented from the grammar rather than from an observed instance — including whether `MELT`
  produces exactly the §6 expansion or something subtly different.
- **The inline modifier form** (`TEMP 95.0,10,INC 0.5`) is likewise stated. Nothing here writes it,
  so whether the instrument's own parser accepts it on every step type is untested.
- **What `RATE` does on a non-melt step.** Every observed `RATE` sits in a melt curve, where it is
  pinned to the increment (§6). A ramp-rate cap on an ordinary hold is allowed by the language but
  never exercised here, so its effect on run time is unmeasured.
- **Whether a modifier can precede its step**, or attach to anything other than the directive
  immediately before it. Every observed modifier follows its step directly.
- **The two leading `STATUS?` counters.** The step number this document relies on is the field
  *after* the current step text (§4, Appendix A). The two numeric fields *before* it both track the
  cycle in the one capture that has a running protocol, and nothing there separates them.
- **`GOTO` into or out of a melt group.** The language forbids a melt inside a `GOTO` loop, and no
  sample targets a step in the middle of a melt's four. A file that did would be ambiguous against
  the XML's single `MeltCurveStep`.

## 10. Writing a protocol: the builder

Everything above reads. Authoring one needs the inverse, and the constraint that shapes it is
that there is no such thing as a *slightly* wrong protocol: a directive is typed at the
instrument one command at a time (§7) and a malformed one fails at that command, halfway through
authoring. So the editable form here is not text at all.

**Implemented by `packages/core/src/protocolBuilder.ts`**, entry point `ProtocolBuilder`. It
holds a protocol as the §3.1 header plus an ordered list of typed steps, and is the only writer
of directive text (`toRunDefinition()`, `toDirectives()`). Three of the language's rules stop
being rules to check and become facts about the representation:

| Rule | How the model makes it true |
|---|---|
| `END` terminates, and nothing follows it (§3.1) | `END` is not a step and has no representation; it is emitted last, always. There is no edit that removes or moves it |
| Step numbers count steps, not modifiers (§4) | A step's number *is* its position — modifiers ride as fields of the step they modify, so inserting or deleting renumbers everything downstream with no bookkeeping |
| A `GOTO` names an earlier step (§3.2) | Targets are repaired across every structural edit, so a loop keeps pointing at the step it pointed at; `legalGotoTargets(i)` is what may be offered |

Every mutator (`withStep`, `withInsertedStep`, `withoutStep`, `withHeader`) returns a **new**
builder rather than mutating, which is what lets an editor keep a plain array of them as an undo
stack.

**Reading is strict, and deliberately narrower than §3.** `fromRunDefinition()` throws for
anything it could not write back unchanged — an unknown verb, a modifier on a step kind that
§3.5 forbids it on, a non-numeric operand, directives after `END`, or a scan mask outside the
four combinations of §5's two measured configurations (all six channels or channel 1;
step-and-repeat or flyover). This is narrower than what `parseRunDefinition` accepts on purpose:
the tolerant reader exists so a partly-understood protocol still *displays*, and a protocol that
can't be represented exactly should be shown rather than silently rewritten. `tryFromRunDefinition()`
returns the reason instead of throwing, which is how a caller decides whether to offer editing at
all.

Two restrictions are **this library's own**, not the language's, and are marked as such because
they are the ones a future measurement could lift: a `GOTO` may not target another `GOTO` (no
observed protocol does, and it has no defined meaning here), and an arbitrary channel subset is
not offered as a scan mask (§9's first bullet — only the two whole configurations have ever been
seen accepted). Everything else it enforces is §3.5's stated limits, surfaced per operand through
`validateStepDraft`/`validateProtocolHeader` so an editor can put the bound beside the field.

> **Implemented.** The web app's Protocol view edits a standalone `.prcl.txt` through this class
> and nothing else — `apps/web/src/components/protocol/`. It never touches protocol text, which
> is why "the file can't end up holding something the instrument would reject" is a property of
> the API rather than of the UI.

## Appendix A: how the step numbering was measured

§4's rule has two halves — that `PLATEREAD` and `GOTO` are counted, and that `INC`/`RATE` are not —
and the instrument's own two accounts of its own runs settle both. Neither needs the XML.

### A.1 The `.alf` execution log

Every `.zpcr` carries an `.alf` run report ([`alf.md`](./alf.md)) whose second line is the run
definition (`*`-delimited, §8) and whose body is one line per executed step:
`-1*<repeat>*<step>*<unresolved>*<temperature>*<hold>*<timestamp>*…`. That `<step>` is the number
this document defines, written by the instrument as it ran. (The fourth column is labelled a ramp
time and does not behave like one — `alf.md` §8 has the measurements; nothing here depends on it.)

`samples/20190516_122922_CT019138_SHORT_QUALIF.zpcr` — a cycling loop then a melt:

```
METHOD CALC*HOTLID 105,30*VOLUME 20*TEMP 98.0,10*TEMP 98.0,5*TEMP 57.5,10*PLATEREAD #h81*
GOTO 2,1*TEMP 56.5,31*TEMP 56.5,5*INC 5.0*RATE 5.0*PLATEREAD #h81*GOTO 7,7*END
```

Its log runs `1, 2, 3, 4` (with `4` = `Plate Read`), then `2, 3, 4` for the loop's second pass,
then `6, 7, 8` — where `6` = `56.5,31`, `7` = `56.5,5` and `8` = `Plate Read` — and then repeats
`7, 8` seven more times with the temperature climbing `61.5, 66.5, … 91.5`.

Three readings fall straight out:

| Observation | What it rules out |
|---|---|
| the melt's plate read is step **8** | that `INC`/`RATE` are counted — they would make it 10 |
| the log jumps **4 → 6**, skipping 5 | that `GOTO` is uncounted — 5 is the `GOTO 2,1` |
| the first plate read is step **4** | that `PLATEREAD` is uncounted — it would be 3 |

`samples/20230829_135443_CT019138_SINGLE_STEP_.zpcr` repeats the experiment with a longer protocol
and a 61-rung melt, logging the melt as steps `8` and `9` against a run definition whose
`INC 0.5`/`RATE 0.5` sit between them and where `GOTO 8,60` targets the hold. Same rule, same
result.

The temperature column corroborates the loop arithmetic independently: `GOTO 7,7` yields 8 rungs
at `+5.0` °C from 56.5, ending at 91.5, which is exactly the `meltCurveEndTemp="91.5"` the
matching XML records (§6).

### A.2 The live `STATUS?` response

While a run executes, `STATUS?` (`usb.md` §3) reports the current step *text* and, in the next
field, its step number. From the `usb-run` capture, whose protocol was
`TEMP 95.0,180;TEMP 95.0,10;TEMP 55.0,30;PLATEREAD #h3F;GOTO 2,1;END`, the four distinct pairs
seen were:

| Step text | Reported number |
|---|---|
| `TEMP 95.0,180` | 1 |
| `TEMP 95.0,10` | 2 |
| `TEMP 55.0,30` | 3 |
| `PLATEREAD #h3F` | 4 |

which is §4's numbering, live, and independently confirms that a plate read holds a step number of
its own. (This capture has no melt, so it says nothing about `INC`/`RATE`; A.1 is what covers
those.)

### A.3 What the XML adds

Where a file carries both forms, the text's `GOTO` target can be checked against the XML's.
`samples/20260720_Luna_noRT.pcrd` has `GOTO 2,44` against `optionGotoStep="1"` (0-based) →
`temperatureStepNumber="1"` = `TEMP 95.0,10`: the same step. `samples/Short
Qualification_Plate_96.prcl.xml` has `GOTO 2,1` against `optionGotoStep="1"` likewise.

This cross-check is real but weaker than A.1, and worth being explicit about: **it cannot
distinguish the two halves of the rule**, because in every committed protocol the modifiers sit
after the last `GOTO` target, so counting them or not resolves every observed target identically.
That is why the numbering claim rests on the execution log rather than on this correspondence — and
why an earlier reading of §4 that counted `INC`/`RATE` as steps survived as long as it did.

Both the cycling and the melt case are asserted in `packages/core/test/runDefinition.test.ts`.
