# Bio-Rad CFX `.alf` Run Report

The instrument's own account of what the block actually did during a run: a small ASCII text file
holding the run's identity, the protocol as executed, an error summary, and **one line per
executed protocol step** with that step's temperature, hold time and wall-clock start.

It is not a data file — no fluorescence, no wells, nothing per-well at all. It is the execution
log: the only artifact in which the instrument, rather than the PC, says what ran and when.

> **Status:** structurally complete — every line, every field, and the numbering rules are
> established against 48 runs. Two things are *not* resolved: the fourth step-line column (§7,
> labelled a ramp time but rarely behaving like one) and the encodings the error line uses when
> something goes wrong (§6) — every sample in the corpus is a clean, completed run.
>
> **Corpus:** 47 distinct `.alf` files carried by 50 `.zpcr` archives (2019-05-16 → 2026-07-26,
> one CFX96, base `CT019138`, block `RN050773`), plus one pulled off the wire in the `usb-run`
> capture (`usb.md` §7.6) — 48 reports, 6,205 step lines. Every one has the identical shape described
> here.

**Implemented by** `packages/core/src/alf.ts`, entry point `parseAlf(bytes)`; `zpcr.runReports()`
decodes every `.alf` entry in an archive, and the web app's Raw files view renders one
(`components/raw/DecodedAlf.tsx`). The decoder derives the three things the file only implies —
per-step durations (§7.4), stage boundaries (§7.2) and plate-read indices (§7.5) — and carries
the fourth step column through uninterpreted (§8), which is also why the app's table omits it.
`alfThermalProfile()` builds on those to reconstruct the block-temperature-against-time trace
(§7.6), which a run's Protocol tab plots beneath the protocol it ran.

Related docs: [`protocol.md`](./protocol.md) owns the protocol language on line 2 and the step
numbering the log uses (its Appendix A is measured from these files);
[`plateread.md`](./plateread.md) owns the `.Plateread` files whose reads line 4-and-after index;
[`usb.md`](./usb.md) §5.2 owns the device directory the file is fetched from.

---

## 1. Where it comes from, and where it turns up

| Location | Name | Notes |
|---|---|---|
| On the instrument, `\Storage Card\PCRunReport\` | `<yyyymmdd>_<hhmmss>_<serial>_<RUN NAME>.alf` | written when the run finishes; survives until deleted, so the directory normally holds the *previous* run's report until something clears it (`usb.md` §5.2) |
| On the instrument, `\Storage Card\CurrentRun\` | same name | a copy, alongside the run's `.Plateread`s and `.Dcal`s |
| Inside a `.zpcr` | usually the same name; sometimes renamed to the archive's own basename | a `.zpcr` is a plain ZIP of the run directory, so the copy above travels with it. Present in **all 50** archives examined |
| Inside a `.pcrd` | **absent** | checked across four `.pcrd` samples — the saved-experiment XML carries `RunInfo`/`runlog` but not the report text |

So a `.zpcr` is the ordinary way to get one; USB is how to get it without saving an experiment.
Sizes run 386 bytes (a 3-step run) to ~13.8 KB (a 45-cycle run plus a 61-rung melt) — the file
grows only with the number of executed steps.

The extension is not otherwise meaningful here; nothing in the format is binary or versioned.

## 2. Lexical structure

- **Pure ASCII** (no byte > 0x7F in any sample), **CRLF** line endings, including after the last
  line.
- Every line is a list of fields separated by `*`, and **every line ends with a `*`**, so a naive
  split yields one trailing empty token on the step and error lines. (The header is the exception
  and is discussed in §4.)
- **No escaping and no quoting.** A `*` inside a run name, user name or sample ID would be
  indistinguishable from a separator; none of the samples contains one, and nothing in the format
  prevents it. Names are also never quoted, so leading/trailing spaces are significant — the error
  summary in §6 is delivered with a leading and a trailing space.
- **Positional, not keyed.** Field meaning is entirely by index; absent values are empty strings,
  never omitted.

Line roles are fixed by position, not by any marker:

| Line | Role | Fields |
|---|---|---|
| 1 | run header | 15 |
| 2 | the protocol as executed | one per directive |
| 3 | error summary | 8 (+ trailing) |
| 4 … *n*-1 | one executed step each | 9 (+ trailing) |
| *n* | end-of-run sentinel — same 9 fields, zeroed | 9 (+ trailing) |

A reader should skip blank lines (the trailing CRLF produces one) and treat everything from line 4
on as step records.

## 3. A complete short example

The whole file for a 3-cycle gradient run (`samples/20260725_GRADIENTTEST.zpcr`), unmodified:

```
GRADIENTTEST*admin*RN050773*A*CFX96*Jul 25, 2026*12:48:11*12:56:53*00:08:42*105.0*25.0**CT019138*CT019138*
METHOD CALC*HOTLID 105,30*VOLUME 25*TEMP 95.0,60*GRAD 55.0,65.0,30*TEMP 55.0,30*PLATEREAD #h3F*GOTO 2,2*END
 No errors reported. *0:*False*False*False*False*None*False*
-1*1*1*.00*95.0*60*07/25/2026 12:48:20*False*0*
-1*1*2*.14*55;65*30*07/25/2026 12:52:20*False*0*
-1*1*3*.10*55.0*30*07/25/2026 12:53:07*False*0*
-1*1*4*.02*Plate Read*0*07/25/2026 12:53:46*False*0*
-1*2*2*.88*55;65*30*07/25/2026 12:54:00*False*0*
-1*2*3*.91*55.0*30*07/25/2026 12:54:35*False*0*
-1*2*4*.05*Plate Read*0*07/25/2026 12:55:11*False*0*
-1*3*2*.65*55;65*30*07/25/2026 12:55:24*False*0*
-1*3*3*1.84*55.0*30*07/25/2026 12:56:01*False*0*
-1*3*4*.04*Plate Read*0*07/25/2026 12:56:37*False*0*
-1*0*0*.00*0*0*07/25/2026 12:56:53 Protocol completed.*False*0*
```

## 4. Line 1 — the run header

Fifteen fields, in this order:

| # | Field | Example | Notes |
|---|---|---|---|
| 1 | protocol/run name | `GRADIENTTEST` | see below — its content depends on how the run was started |
| 2 | user | `admin` | empty for runs started at the instrument's touchscreen (15 of 47 archived samples) |
| 3 | block (alpha) serial | `RN050773` | matches `ALPHASN?` / `RunInfo.xml`'s `AlphaSerialNumber` |
| 4 | block letter | `A` | the block designator `RemoteRun` takes |
| 5 | block descriptor | `CFX96` | the plate/block type |
| 6 | date the run began | `Jul 25, 2026` | **en-US month abbreviation**, zero-padded day |
| 7 | start time | `12:48:11` | 24-hour, instrument local time, no zone |
| 8 | end time | `12:56:53` | same |
| 9 | total elapsed | `00:08:42` | `hh:mm:ss` |
| 10 | lid temperature | `105.0` | the `HOTLID` setpoint, not a measurement (`105.0` in all 47) |
| 11 | sample volume | `25.0` | the `VOLUME` setpoint, µL |
| 12 | sample ID | *(empty)* | `RemoteRun`'s operand 6; empty in all 47 samples |
| 13 | cycler nickname | `CT019138` | defaults to the base serial when never renamed |
| 14 | base-unit serial | `CT019138` | matches `*IDN?` / `BASESN?` |
| 15 | lid pressure | *(empty)* | empty in all 47 samples |

Field 15 being empty in every sample means the header line's terminating `*` and an empty 15th field
are **indistinguishable** in this corpus: a split yields exactly 15 tokens either way. Read the
header as "15 fields, last one empty" and both readings agree.

**Field 1 is not always a run name.** For a PC-started run it is the name given to `RemoteRun`,
uppercased (`singletest` → `SINGLETEST`). For a run started at the instrument's touchscreen it is
instead the *path of the protocol selected there*, e.g.
`\Storage Card\Recent\Luna_noRT`, and field 2 (user) is empty. Both forms appear in the corpus; a
reader wanting a display name should take the basename and not assume either shape.

Names in this corpus are also never longer than 12 characters (`KAPA_PROTOCO`, `SINGLE_STEP_`,
`SHORT_QUALIF` are all visibly truncated, in the enclosing `.zpcr` filename too). Whether the
report truncates or merely records an already-truncated name can't be told from the file alone.

Fields 3, 4, 13 and 14 make the header a self-contained provenance record: which block, in which
base unit, ran this — no other file in the archive is needed to say so.

## 5. Line 2 — the protocol as executed

The full run definition, `*`-delimited, in the same directive language every other carrier uses.
**[`protocol.md`](./protocol.md) is the authority**; §8 there tabulates how this carrier differs
from the four others (separator `*`, terminator a bare `END`, and — unlike the `.prcl`/`.pcrd`
copy — the `PLATEREAD` operand is the mask the run actually used).

Directives observed on this line across the corpus: `METHOD`, `HOTLID`, `VOLUME`, `TEMP`, `GRAD`,
`INC`, `RATE`, `PLATEREAD`, `GOTO`, `END`.

The distinction that makes this line worth having: it is what *ran*. The `.prcl`/`.pcrd`
`runDefinition` is what was *authored*, and it normalizes the scan mask; `ProtocolRunDefinition.txt`
in the same archive is the PC's copy. When they disagree, this one is the instrument's word.

## 6. Line 3 — the error summary

Eight fields:

| # | Field | Observed value | Notes |
|---|---|---|---|
| 1 | error summary text | `␣No errors reported.␣` | human-readable; note the leading and trailing spaces |
| 2 | raw error codes | `0:` | a `:`-terminated/-separated list; only the empty case is observed |
| 3 | power failed | `False` | |
| 4 | user aborted | `False` | |
| 5 | an error occurred | `False` | |
| 6 | emulation mode used | `False` | a flag, paired with the name in field 7 |
| 7 | emulation mode | `None` | |
| 8 | critical error occurred | `False` | |

**All 47 archived runs and the captured one are clean**: every field above is identical in every
sample. So the *shape* is certain and the *failure encodings are not* — how a code list renders
with codes in it, what an aborted run's summary text says, and whether field 5 is redundant with a
non-empty field 2 are all unknown. A reader should test flags for the literal `True` and treat
anything else as false, and should not assume field 2 stays parseable as an integer.

The flags are the natural place to look before trusting a run's data: a report saying
`power failed` or `user aborted` describes a run whose later cycles may not mean what they seem.

## 7. Lines 4+ — the executed-step log

One line per step *execution* — not per protocol step, and not per cycle. Nine fields:

| # | Field | Example | Meaning |
|---|---|---|---|
| 1 | cycle number | `-1` | **`-1` in all 6,205 step lines** in the corpus. Carries nothing; don't read it |
| 2 | repeat index | `3` | 1-based pass through the current loop block — see below |
| 3 | step number | `4` | the protocol's 1-based step index, exactly as [`protocol.md`](./protocol.md) §4 defines it and `STATUS?` reports it live |
| 4 | *(labelled ramp time)* | `1.84` | **unresolved — see §8** |
| 5 | temperature | `95.0`, `55;65`, `Plate Read` | the step's setpoint, the gradient's `low;high` (integers), or the literal `Plate Read` for an optical step |
| 6 | hold time | `30` | the step's *nominal* hold in seconds — the protocol's number, not the time actually held. `0` for a plate read |
| 7 | timestamp | `07/25/2026 12:56:01` | **when the step began**, `MM/DD/YYYY HH:MM:SS`, instrument local time, no zone. On the last line it also carries a status phrase (§7.3) |
| 8 | paused | `False` | `False` in every line of every sample |
| 9 | time paused | `0` | `0` in every line of every sample |

### 7.1 Which steps get logged

- Every executed `TEMP`/`GRAD` hold and every `PLATEREAD` gets a line.
- **`GOTO` never gets one** — the step index visibly jumps over it (`… 3, 4, 6, 7 …`), which is one
  of the measurements behind `protocol.md`'s numbering rule.
- `INC`/`RATE` never get one either; they are modifiers of the preceding `TEMP`, not steps, and the
  numbering skips them accordingly.
- Pre-loop holds appear once, under repeat index 1; loop bodies repeat.

### 7.2 Repeat index and stages

Field 2 counts passes through the loop block currently executing, and **resets to 1 when the
protocol moves into a later loop block**. A qPCR-then-melt protocol therefore logs
`1…40` against the cycling steps and then `1…61` again against the melt steps — the two are told
apart by field 3, whose value jumps to the melt's step numbers and stays there
(`samples/20230829_135443_CT019138_SINGLE_STEP_.zpcr`, whose melt is
`… PLATEREAD #h3F*GOTO 3,39*TEMP 65.0,31*TEMP 65.0,5*INC 0.5*RATE 0.5*PLATEREAD #h3F*GOTO 8,60`):

```
-1*40*5*.05*Plate Read*0*08/29/2023 15:03:27*False*0*    ← last cycling read (step 5, cycle 40)
-1*1*7*.67*65.0*31*08/29/2023 15:03:40*False*0*          ← melt begins: repeat resets, step 5→7
-1*1*8*.06*65.0*5*08/29/2023 15:04:16*False*0*
-1*1*9*.06*Plate Read*0*08/29/2023 15:04:20*False*0*
```

Step 6 is the `GOTO 3,39` and step 10 the `GOTO 8,60`; neither is ever logged (§7.1).

There is no explicit stage field. A stage boundary is exactly "field 2 went backwards".

### 7.3 The sentinel line

The last line is always `-1*0*0*.00*0*0*<timestamp> <phrase>*False*0*` — repeat and step both `0`,
temperature and hold both the literal `0`, and the timestamp field carrying a trailing phrase. In
all 48 reports the phrase is `Protocol completed.` and the timestamp equals the header's end time.
A parser should detect the end of the log by `step == 0` rather than by matching the phrase, and
should expect other phrases for runs that didn't complete (none are in the corpus).

### 7.4 Timestamps mark the *start* of a step

This is measured, not assumed. Simple hold arithmetic can't settle it — the interval between two
consecutive lines is a ramp plus a hold under either reading — but two observations can:

- **A skipped step.** In the `usb-run` capture the operator sent `PROCEED` 215 s into a 180 s
  hold — `usb.md` §7.5. The report's step-1 line carries a timestamp 9 s after the run's start,
  far too early to be the completion of a 180 s hold, and its step-2 line lands 214 s in, the
  moment the skip took effect.
- **Against the plate-read files.** For `samples/20260720_FirstQualification.zpcr`, each
  `Plate Read` line runs 12–13 s *earlier* than the corresponding `.Plateread`'s own `DATETIME`
  field (which is in **GMT**, while these timestamps are local): read 1 logs `21:23:04` here
  against `Tue, 21 Jul 2026 05:23:17 GMT` there. The next step's line then follows ~13 s after the
  `Plate Read` line — so the read *begins* at the logged time, takes ~12 s, and the file is stamped
  when it lands.

Consequently **the wall time a step took, ramp included, is the next line's timestamp minus this
one's** — the report never states a duration directly. That decomposes cleanly against the
protocol: a 95 °C → 60 °C step holding 30 s consistently occupies ~46 s, i.e. ~16 s of cooling and
settling before the hold; the same block going 60 °C → 95 °C for 10 s occupies ~22 s. Sub-second
resolution is not available — timestamps are whole seconds.

### 7.5 Plate-read lines index the `.Plateread` files

The `Plate Read` lines are **1:1 with the archive's `Read0000N.Plateread` files, in order** —
verified across all 50 archives (10, 45, 45, 101, 3, … reads each, zero mismatches). That makes the
report the cheapest way to attach a wall-clock time, a cycle index and a stage to each read without
parsing the reads themselves, and a way to notice that a read is missing.

### 7.6 Reconstructing the thermal profile

The one thing a run report is uniquely able to show — and the only place in the archive it can be
got from — is **what the block temperature actually did, against wall-clock time**. Nothing in the
file draws that curve; it falls out of §7.4's differencing plus the nominal hold on each line.

For a `TEMP`/`GRAD` step at time *t* with hold *h*, occupying *took* = (next line's timestamp − *t*):

```
ramp:  t            → t + (took − h)   block travelling to this step's setpoint
hold:  t + (took−h) → t + took         block sitting at it
```

Ramp first, because the hold cannot begin before the block arrives; `took − h` is therefore the
time the transition cost, measured. This is the decomposition to use — **not** the fourth column,
which is labelled a ramp time and doesn't behave like one (§8).

Three rules make the trace well-formed:

| Case | Rule | Why |
|---|---|---|
| A `Plate Read` line | the whole span is a hold at the *previous* step's temperature | a read has no setpoint of its own; `took − h` here is the ~12 s the read takes, not a ramp |
| The **first** step | drop its ramp; the trace starts where that ramp ends | the report never records what the block was at before the run, so the ramp has no starting temperature |
| `h > took` | clamp the ramp to zero | timestamps are whole seconds, so a 1 s overrun is rounding; more would say the log and the protocol disagree about that step |

The last of those is rare and small, measured: across the committed samples exactly one step
overruns its hold at all — the 2019 multistep run's 56.5 °C step 7, nominally 5 s inside 4 s of
clock — so a decomposition that produced clamping *often*, or by more than a second, would be
evidence against the rule rather than against the timestamps.

A `GRAD` step has no single temperature — the block is deliberately spread across the plate's rows.
Its midpoint is what a single line can plot; the `low;high` span from field 5 is worth carrying
alongside so the plot can show the spread rather than implying a uniform block.

Because plate-read lines are 1:1 with the archive's reads (§7.5), each read is a *numbered* point
on this trace, which is what ties an amplification curve's cycle back to a wall-clock moment and a
block temperature.

**Implemented by** `alfThermalProfile(report)` in `packages/core/src/alf.ts`, which returns the
segments and read points above; the web app plots them under a run's Protocol tab
(`components/protocol/ThermalProfileChart.tsx`).

## 8. The fourth column, and why not to trust it

CFX Manager's own converter calls this field `RAMPTIME`; this repo previously read it as a °C
delta. The data supports neither reading cleanly:

- Across 6,205 step lines, **95% are below 3 s**, with a long-tailed minority at 12–19 s.
- For the commonest transition in the corpus, 95 °C → 60 °C, the value is **bimodal**: 88% of the
  time it is under 3 s (median 0.93), and 12% of the time it is ~12.1 s. Wall-clock differencing
  (§7.4) says that ramp really does take ~12–16 s, *every* time — so the large value is plausible
  and the small one, which is the common case, is not a ramp duration.
- The effect is **direction-asymmetric**: down-ramps (95→60, 95→55) produce the large values;
  up-ramps of the same magnitude essentially never do (0% above 3 s across 1,691 lines).
- As a temperature delta it makes no sense either: a 35 °C transition would have to read `35`.
- On *small* transitions the numbers are entirely plausible as ramp times — melt rungs stepping
  0.5 °C at `RATE 0.5` sit at ~0.7 s, run after run. So the likeliest reading is a genuine ramp
  measurement that simply fails to capture the long ones, rather than a measurement of something
  else entirely — but that is a guess, and nothing in the corpus pins down when it captures.

Either way it is not usable as the step's ramp time, and it is not a °C deviation. Read the
timestamps instead (§7.4) — they measure ramps directly and agree with themselves. This is the one
part of the format that is genuinely unexplained.

## 9. What the file is good for

- **Ground truth for timing.** The only per-step wall-clock record the instrument produces; ramp
  and plate-read costs fall out of differencing timestamps, which is what makes run-duration
  estimates possible without a live run — and, assembled, the run's whole thermal profile (§7.6).
- **What actually ran.** Line 2 is the executed protocol, with the real scan mask.
- **Provenance.** Block and base serials, block type, operator, start/end, lid and volume settings —
  independent of `RunInfo.xml`.
- **Run integrity.** The error line's flags, and the read-count check of §7.5.

## 10. Field names and provenance

The field names used above are CFX Manager's own: its converter turns an `.alf` into an XML
document with element names `PROTOCOLNAME`, `USERNAME`, `CYCLERNAME`, `CYCLERSN`, `BLOCKSN`,
`SAMPLEID`, `BLOCKTYPE`, `BLOCKLETTER`, `DATEBEGAN`, `TIMEBEGAN`, `TIMEEND`, `TOTALTIMEELAPSED`,
`SAMPLEVOLUME`, `LIDPRESSURE`, `LIDTEMPERATURE` for the header; `ERRORSTRING`, `RAWERRORS`,
`POWERFAILFLAG`, `USERABORTED`, `ERRORFLAG`, `EMULATIONMODE`, `CRITICALERROR` for the error line;
and `CYCLENUMBER`, `CYCLEREP`, `STEPNUMBER`, `RAMPTIME`, `TEMPERATURE`, `HOLDTIME`, `ERRORCODE`,
`PAUSED`, `TIMEPAUSED` per step, under a `RUNLOG` root with the protocol text repeated as
`VISUALLINE` elements.

Two of those names are misleading and the data is the authority: **`ERRORCODE` (step field 7) holds
a wall-clock timestamp** in every line of every sample — never a code — and `RAMPTIME` behaves as
§8 describes. The step field named `CYCLENUMBER` is the constant `-1`; the useful counter is
`CYCLEREP`.

### What is still unknown

- The fourth step column (§8).
- Every failure encoding: non-empty error-code lists, aborted/power-failed runs, a non-`completed`
  sentinel phrase, and whether `PAUSED`/`TIMEPAUSED` ever leave `False`/`0`.
- Whether `LIDPRESSURE` and `SAMPLEID` are ever populated on this instrument class.
- Whether other block types (non-CFX96, multi-block C1000s) change field 5 or add fields — the
  whole corpus is one CFX96 block in one base unit.
