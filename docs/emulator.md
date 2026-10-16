# The CFX96 emulator — an instrument that isn't one

## 1. What it is for

Everything past the Instrument view's Connect button used to be untestable. The protocol client
(`usb.md` §10, `packages/core/src/usb/`) had unit tests for its framing and its command queue, but
`startRun`, `cancelRun`, `sendFile`, `runReport`, `clearRunReports` and `deviceInfo` — some three
hundred lines of it — had no automated coverage at all and were verified only by an operator
watching a real CT019138. Above them, the browser suite could open the Instrument view and assert
that it looked right disconnected, and nothing more.

The recordings in `samples/` do not close that gap. A `usb-traffic.bin` is a **transcript**: it can
be read back, but it cannot be *talked to*. A run has to be driven to be tested — the host asks a
question, the instrument's answer depends on what it is doing at that moment, and the next question
depends on the answer. So this is an instrument that answers: a stateful CFX96 that speaks the raw
protocol over the same interface a real one does, with no hardware and no WebUSB.

It is also how the Instrument view gets built without an instrument on the desk (the **Fake device** button, §9).

> **This document exists because the emulator is a thing to be trusted or not.** It is a second
> implementation of a protocol this project reverse-engineered, so a test that passes against it
> proves something about the app *and something about our reading of the instrument* — and those
> are not the same claim. §10, §11 and Appendix A are about telling them apart.

## 2. Where it plugs in

`packages/core/src/usb/transport.ts` draws the only browser/Node line in the stack, and draws it
structurally: `CfxDevice` takes anything satisfying `UsbDeviceLike` — eleven members, no base
class, no adapter — and core never touches `navigator`. The emulator implements that interface.

```ts
import { createCfxEmulator } from "@zpcrweb/core/emulator";
const device = new CfxDevice(createCfxEmulator({ data }));
```

Nothing above the handle knows the difference: not `CfxDevice`, not `planRun`, not `CfxSession`,
not `RunFollower`, not the view. That is the property the whole exercise rests on — an emulator the
client had to be *taught about* would be testing a code path that only exists in tests.

It ships on its own entry point, `@zpcrweb/core/emulator`, so the web app can reach it through a
lazy `import()` and a build that never sets the mock flag never downloads it.

## 3. The wire

`emulator/transport.ts` speaks the real framing: the 5-byte application header of `usb.md` §2,
`FrameReassembler` on the way in, `REQUEST_HEADER`-shaped frames on the way out, and a bulk read
that **parks** when there is nothing to say, exactly as a real endpoint blocks. No shortcuts — a
transport that answered a command directly, rather than by pushing framed bytes at a read pump,
would make every test above it meaningless.

Two details that are behaviour, not decoration:

- A reply goes to the **oldest** parked reader, because that is what a FIFO endpoint does.
- `close()` **rejects** every parked read, because WebUSB rejects an in-flight `transferIn` when
  the handle closes and `CfxDevice`'s pump reads that rejection as "the handle is gone". Without
  it a disconnect leaves a dead client parked on the endpoint and the *next* client's first answer
  is delivered to the corpse. See §10 — this was a real bug, and only a browser found it.
- `close()` **keeps anything already queued.** A reply the host never read is in the instrument's
  pipe, and closing the host's handle does not empty it: the next connection reads it first.
  Observed on a real instrument — a reload mid-poll left a `STATUS?` answer in the pipe, and the
  Identity panel of the next connection showed it as the model, with every reply after it one
  command behind. `CfxDevice.identify` turns such a reply away (`usb.md` §3, "A connection starts
  in step"), and the transport keeping the queue is what lets `usbDevice.test.ts` and
  `session.test.ts` prove it.

## 4. The filesystem

`emulator/filesystem.ts` holds a path→bytes map and the commands of `usb.md` §5, including the
quirks that make the real one awkward:

- **`LISTALLFILES` ignores its own path argument** and replays whatever the preceding
  `GETFILESLEN` buffered, which is why `CfxDevice` holds the channel across the pair.
- The binary `GETFILESLEN` replies — `7,0,9,0` for an empty directory, `4,0,9,0` for one that
  isn't there — rather than a text code.
- The five-command upload cycle (`DELFILE` → `CRCSENDFILE` → `COMPUTEFILECRC` →
  `GETFILESLEN`+`LISTALLFILES` → `GETFILECRC`), with `crc.ts`'s byte-interleaved XOR.
- **A reply longer than 65,530 bytes goes out as several messages** of that length and a
  remainder, each under its own header (`frame.ts`'s `MAX_MESSAGE_PAYLOAD`) — measured in
  the `usb-basic` capture (`usb.md` §5), and the only way a file over 64 KB fits a `uint16`
  length field. No file the emulator produces is that long; a seeded one can be.

Four directories exist under `\Storage Card`: `CurrentRun` and `PCRunReport`, which the run
writes into, and `Real-Time Data` and `Logs`, which on the real instrument hold a `.zpcr` and a
`.txt` per completed run and five instrument logs respectively (`usb.md` §5, measured in
`usb-basic`). The emulator has them **present, and never writes into them**: when the instrument
does is unwitnessed (§11), and a listing that agrees with the capture while the contents are
invented would be worse than one that says "nothing here". They hold only what the caller puts
there: `initialFiles` (full path → bytes) seeds any existing directory before the session starts,
and refuses one the instrument doesn't have. The app's Fake device seeds `Real-Time Data` with three
bundled `.zpcr`s, all over 64 KB — real runs, so nothing in them is invented — and leaves the
`.txt` beside each out, since what it holds has never been read.

## 5. The run

`emulator/schedule.ts` turns a protocol into a timetable and `emulator/run.ts` executes it, both
over `runDefinition.ts`'s `walkProgram` — the same loop-walking the rest of the library uses, so
`GOTO` semantics exist in one place rather than two.

The sequence is `usb.md` §7's, in order: `PROTOCOL 'PCRUN'` + directives + `END` to author,
`RemoteRun` to start (and **only** `RemoteRun` — `PROCEED` skips a step, it does not start
anything), `ADDCYCLES 0` as ordinary setup, then the files deposited *after* the run has appeared
in `STATUS?`. What follows:

- `CurrentRun` is emptied of the previous run as the new one becomes visible — so a file written
  inside the start window is lost, as one can be on the instrument (Appendix A).

- A `Read0000N.Plateread` appears when its `PLATEREAD` step **ends**, not when it begins.
- **The last read is not listable until the run is acknowledged** (§7.6). A finished protocol
  leaves `STATUS?` reporting `IDLE` with the run's name still attached — the instrument is
  *holding* the run. `CANCEL` makes the final read appear at once, and **releases** the run
  `RELEASE_MS` (1.5 s) later: only then do `ended` and the `.alf` appear and `STATUS?` drop the
  name — measured to happen somewhere between 0.32 and 2.75 s after the `CANCEL`. A client that
  lists the folder the moment `CANCEL` returns gets no `ended` and no report, here as on the
  instrument (`CfxDevice.releaseRun` waits).
- `CANCEL` therefore means two different things depending on when it arrives, and inside the
  start window — ~10.7 s for a run with plate reads, ~5.5 s for one without — it is answered
  `0000` and **ignored** (§7.8).
- **The block and lid cool from where the run left them**, rather than snapping to ambient, and a
  run started while the lid is still warm has a shorter preheat — it lasts until the lid is within
  10 °C of its setpoint. `temperatures` seeds where they sit before the first run.
- `PAUSE`/`RESUME` freeze and resume the run's clock.
- **A thermal-only protocol writes no run folder at all** (§7.10). Its entire output is the `.alf`.
  That asymmetry is load-bearing: it is what `RunPlan.producesRunFile` exists for, and the app's
  report-only path had never been exercised before.

`emulator/report.ts` writes the `.alf`, generated from the schedule that actually ran rather than
copied from a recording — a report that described a different run would be worse than none.

**Every duration in the run is measured** (`schedule.ts`'s table, `usb.md` §3.2 and §7.3): the two
start windows; the preheat, from the lid's temperature at 0.455 °C/s; each ramp from how far the
block has to go — 3.1 °C/s up, 2.35 °C/s down, nothing at all for a step at the setpoint the last
one held; a `PLATEREAD #h3F` at 12.5 s. Against the 45-cycle recording every kind of step comes
out within 1.5 s of the instrument's median and the whole protocol within 1.1 % (§10.1). `STATUS?`
reports field 2 as the instrument does — 1 until a loop's `GOTO` has run, then the loop's total —
and field 9 as the hold, as field 12. Inside a ramp the block moves linearly, which is this
emulator's own; and the at-target bit carries over from the step before for `AT_TARGET_LAG_MS`
(250 ms) after a setpoint change, as the instrument's does.

## 6. Time

`emulator/clock.ts`. One contract, three implementations:

| clock | what it is for |
|---|---|
| `realtimeClock(speed)` | wall time, optionally scaled; `setSpeed` is live |
| `acceleratedClock()` | **no timers at all** — simulated time advances only when the host asks, one step per `STATUS?` |
| `manualClock()` | `advance(ms)`, for a test that wants to sit inside a step |

**The invariant: simulated time never jumps, in either direction. A speed change governs only the
time from that moment on.** So changing speed *rebases* — it recomputes the origin to `now()`
before storing the new rate — rather than rescaling elapsed wall time, which would move time that
has already happened: backwards when the speed drops, forwards in a leap when it rises.

This matters more than it sounds. A run's elapsed seconds, its step timer, the live thermal chart
and the follower's edge detection are all **differences between successive `STATUS?` replies**, and
a real instrument's clock only advances. An emulator whose clock could go backwards would be
testing the app against a machine that cannot exist: a bug found that way isn't real, and a bug
hidden that way is.

The accelerated clock is what makes browser checks fast *without* a single fixed `sleep`: the run's
progress is a pure function of how many polls have happened, so a check waits on state it is about
to assert rather than on a duration.

## 7. The data

`emulator/data.ts`. `recordedRunData(archive)` lifts **one curve per channel** out of a recorded
run's own plate reads and writes that same curve into all 108 wells, which is what the feature
asked for. The bytes are produced by `encodePlateRead` (`plateread.md` §7), so a read is a real
`.Plateread` — same 42-field header, same 648-record table, same descriptor dictionary — carrying
this run's cycle number and temperatures rather than the recorded run's.

Three kinds of run, from three committed samples:

| kind | recording |
|---|---|
| qPCR | `samples/20260807-YouSeq_RT_-_S56.zpcr` (45 reads — the file is named for the heat-block run that pulled them, whose folder still held the previous qPCR's output; see §10.1) |
| melt | `samples/20230829_135443_CT019138_SINGLE_STEP_.zpcr` (the melt `melt.md` §A.1 measures) |
| heat block | none needed — a thermal-only run writes no reads, so `data` is optional |

The run folder's other files — `runlog.xml`, the `.Dcal` calibration set and `RunInfo.xml` — come
from the recording too, verbatim except for **`RunInfo.xml`'s four per-run keys**, which
`emulator/runInfo.ts` rewrites for each run: `Identifier` (a GUID-shaped value derived from the
request time and run name), `RunStartTime` (the run clock's zero, on the same "GMT" clock as the
reads' `DATETIME`), `DataFile` (`<yyyymmdd>_<hhmmss>_<serial>_<name>.zpcr`) and `RunDefinition`
(the protocol as run). Every other key — serials, firmware, factory calibration — is the
instrument's rather than the run's and keeps the recording's bytes. This is not cosmetic: a host
identifies a run by its `RunInfo.xml` (`runFolder.ts`'s `isSameRun`), and with the recording's
copy every emulated run looked like the same run, so the app's run follower merged a second run
into the first one's file.

**Core stays I/O-free**: the caller supplies the archive. In Node a test reads `samples/` off disk;
in the browser the app fetches the bundled copy. Core never opens a path.

## 8. What it deliberately does not model

Recorded so nobody "completes" it:

- **The unsolicited channel-0 and channel-2 binary traffic.** `usb.md` §4 is only partly
  understood, and inventing it would be inventing evidence. The emulator is silent there.
- Other block types, other plate sizes. One CFX96, which is what every recording is.
- Hardware faults; a populated `ERRORLIST` or `RTSTATUS?` fault list.
- Transfer jitter, retries, halted endpoints. The read pump's error handling is tested with
  injected failures instead (`usbDevice.test.ts`).
- Per-well variation — explicitly out of scope; every well gets the same curve.
- `GRAD`'s per-row gradient: the high temperature stands for the whole block.
- `INC`'s effect on `STATUS?`'s step text. The text stays verbatim; the `.alf` and the block
  temperature do increment.
- A run started at the instrument's own touchscreen.
- `runlog.xml`, the `.Dcal` set, and every `RunInfo.xml` key but the four §7 rewrites are carried
  verbatim from the recording, so they describe the **recorded** run, not the emulated one.

## 9. Using it

**Node** — see `packages/core/test/emulator.test.ts` for the full shape:

```ts
const emulator = createCfxEmulator({ data: recordedRunData(archive), clock: acceleratedClock() });
const device = new CfxDevice(emulator);
await device.open();
await device.startRun(planRun({ runDefinition, plate, name }));
```

**Browser** — the Instrument view's **Fake device** button, which appears beside Connect over USB
once a real connect fails (or from the start in a browser with no WebUSB). While it is connected
the rail says outright that nothing here is an instrument, and offers a speed control: 10× / 60×
scale time, and Max advances a step per poll, which is what the browser checks use. (The app
runs its own `switchableClock` — `apps/web/src/state/mockInstrument.ts` — rather than core's
`acceleratedClock()`, so that changing speed mid-run never has to rebuild the instrument and lose
the run inside it. Same contract, same rebasing rule.) The
emulator is built once per page, not per connection, so disconnecting is unplugging a cable: the
run goes on running and connecting again finds it mid-run.

## 10. How it is validated, and how far

Three checks, in decreasing strength.

### 10.1 Message-for-message against two real sessions

Two committed `.zpcr`s carry a `usb-traffic.bin` of a complete session against CT019138 — connect
→ author → start → watch → finish → pull, recorded by this app itself.
`packages/core/test/emulatorFidelity.test.ts` replays every host→device command of each, in order,
at an emulator whose clock is advanced to the recording's own timestamps, and compares every answer
with the instrument's. It is the only check in the suite with an outside witness.

| recording | commands | the run | what only it witnesses |
|---|---|---|---|
| `20260807-YouSeq_RT_-_S56.zpcr` | 5 390 | `METHOD BLOCK`, three `TEMP` steps, **no `PLATEREAD`** — an hour of reverse transcription, a heat-block run (`usb.md` §7.10) | the thermal path, and the whole file-transfer path: the 45 plate reads and `.alf` it pulls at the end are the *previous* qPCR run's, still in `CurrentRun` because a thermal-only run writes no folder |
| `20261014-S187_S188_S189_cold_check.zpcr` | 7 801 | `METHOD CALC`, `GOTO 2,44` — a 45-cycle qPCR run | **a qPCR run executing**: the folder clear, 45 reads pulled as each step ended, field 2, every ramp and read, the finish and its release |

Neither witnesses a melt, a cancel or a pause.

What is compared, per command:

| | |
|---|---|
| reply shape | value + `;` + code, a bare code, or raw bytes — per command, against the instrument's |
| result code | exactly. Every code in both sessions is `0000`, on both sides |
| whole replies | the heat-block session: 213 of its 222 non-poll replies **byte for byte**, GUIDs and the terminator aside, including 82 whole-file transfers. The qPCR session: 161, including 36 whole files — every file the emulator is handed rather than makes (32 `.Dcal`s, the deposited plate and `zpcrweb.json`, the previous report, `ProtocolRunDefinition.txt`, `lastplatereadstatus`) |
| `STATUS?` | 20 fields, and **which** of them are populated, per phase of the run — the values cannot match, so they are checked for plausible range and for an elapsed clock that only advances |
| the run descriptor | exactly: field 6 is built from `RemoteRun`'s own operands, so both sides must spell it the same |
| the sequence | the run's edges — idle → preheat → each step, with fields 2 and 3, in order → the finished-and-held state — as a *sequence*, never per poll. The qPCR session's 139 edges are identical, `1/1` through cycle 1 and `45/2` … `45/45` after |
| the timing | the qPCR session's start window, preheat, and the median length of each kind of step against the emulator's schedule — within 1.5 s each, the whole protocol within 1.5 % (it is 1.1 % short) |

The replay seeds what a recording's instrument held: `CurrentRun`'s listing, the previous run's
report, and the block and lid where the recording had them — the lid where the preheat began,
37.7 °C in the qPCR session, since a warm lid is what made that preheat 45 s short.

Every remaining difference is printed by the test rather than tolerated silently, and anything
outside the recording's list fails the run naming the command. What they found, and what each one
means:

| difference | in | what it is |
|---|---|---|
| **Reply terminators** | both | the instrument ends some replies `\r\n` and others bare, *per command*: `*IDN?`, `BASESN?`, `ALPHASN?`, `ALPHAID?`, `BLOCKDESC?`, `BLOCKCOUNT?`, `CPLD?`, `VOLUME?`, `LIDFORCE?`, `LIDVERSION?`, `LIDBVERSION?`, `ERRORS?`, `PROTOCOL`, `METHOD`, `HOTLID`, `VOLUME`, `TEMP`, `PLATEREAD`, `GOTO`, `END`, `ADDCYCLES` and `CANCEL` carry CRLF; `STATUS?`, `RTSTATUS?`, `RemoteRun`, `FrontEndSoftware?`, `SUPERLOCKDOWNMODE?`, `GETFREESPACE`, `GETTOTALRAM` and every file command do not. The emulator emits none. `parseResponse` strips either, so nothing in the client notices — but a client that compared a reply to `"0000"` would pass here and fail in the lab |
| **`GETFILE` is not `passThrough`** | both | printable files come back through this app's own recorder as *text*, which only happens when the response header's passThrough bit is clear. The emulator sets it |
| **Listing order** | both | a file deleted and written again keeps its place in the instrument's listing (and the staging GUID always lands last, in the slot the previous one freed — FAT directory-entry reuse, in all likelihood). The emulator's listing moves a rewritten file to the end, and writes a run's support files before the host's deposit where the instrument lists them after |
| **Staging GUID lifetime** | both | the GUID copy `CRCSENDFILE` leaves behind is gone from the instrument's listing by the end of the run. The emulator keeps it until the next upload, so its listing is one name and 37 bytes longer |
| **The at-target bit can fall back** | both | a poll reported *not* at target with the hold clock already running — an overshoot (once in 2 585 polls, 14 times in 3 744). The emulator's at-target bit never falls back once a step has arrived |
| **Run duration** | heat block | this run's lid heated at 0.469 °C/s against the 0.455 the emulator takes for all three runs measured, so its preheat ran ~4.5 s longer than the instrument's — and the session's last `CANCEL`, sent 1.4 s after the real finish, arrived while the emulator's last hold still had 5 s to go. A `CANCEL` on a running run aborts it, so the emulator's run ends cancelled where the instrument's ended clean. Every edge before that is identical |
| **Stale replies at connect** | qPCR | the session's first five replies belong to the command before — a reply left in the pipe by the previous connection. `CfxDevice.identify` now turns one away (`usb.md` §3); these five are skipped, not compared |
| **The deposit inside the start window** | qPCR | the session deposited its files before the run appeared, while the firmware was still clearing the folder (`usb.md` §7.4), which cost it its `.prcl.txt`. The client now waits for the run, so the replay sends the deposit there — and the instrument's half-cleared listings, its `0000` to a `DELFILE` the clear had not yet reached, and the `.prcl.txt` the emulator keeps, are the recording's timing rather than the emulator's |
| **Synthetic plate reads** | qPCR | same size and shape as the instrument's, one curve per channel in every well (§7) — never the same bytes |
| **`RunInfo.xml`** | qPCR | the emulator writes the four run-own keys itself (§7); every other key is compared, and matches |
| **`runlog.xml`** | qPCR | carried from the recording's finished run (§8); the instrument's grows through the run |
| **Register 97 at the finish** | qPCR | the first `IDLE` poll still carried the run's register 97 before the 32 of §7.6. Not emulated: the other two recorded finishes went straight to 32 (`usb.md` §3.2) |
| **`GETFREESPACE`, GUIDs, temperatures, clocks** | both | instrument-specific by nature; compared for shape only |
| **Two files** | heat block | the archive is not a byte-identical copy of what the instrument held: the app overwrote `zpcrweb.json` during the session, and rewrote the plate `.csv`'s header (`FAM Ch1` → `FAM`) on the way in. The emulator serves what it was handed, so this is a fact about the app, not about the emulator |

**Fixed rather than recorded.** Disagreements that were the emulator's own mistakes, each now a
test:

- *From the heat-block session:* `STATUS?`'s run descriptor is uppercased, cut to eight characters
  **and has filename-hostile characters replaced** — `YouSeq RT - S56` comes back `"YOUSEQ_R"`,
  not `"YOUSEQ R"` (`usb.md` §7.3, corrected in the same commit).
- *From the qPCR session:* every duration (the constant 10 s ramp, the fixed 168 s preheat, a
  6 s start window for every run and a 15.2 s plate read); field 2, which the emulator echoed from
  field 3; field 9, which it reported as ramp plus hold; `ProtocolRunDefinition.txt`'s CRLF; the
  block and lid dropping to ambient at the finish; and the acknowledgement releasing the run, and
  writing `ended` and the `.alf`, in the same instant as the `CANCEL`. That last one was also the
  client's bug: it listed the folder 0.3 s after its `CANCEL` and filed the run without either
  (`usb.md` §7.6, "The release"; `CfxDevice.releaseRun`).

**And the thing this check cannot do at all:** every result code in both recordings is `0000`.
The instrument was never asked anything it refused, so the property Appendix A cares about most —
that the emulator is never *more permissive* than the real thing — has no witness here. All this
proves on that front is that the emulator invents no failure where the instrument succeeded.

**Adding a recording** is a `RecordingSpec` in the test: its path, how to seed the instrument it
talked to, and the divergences it is allowed — each one written down above first.

### 10.2 Against the two USBPcap captures

`usb-basic` and `usb-run` are CFX Manager talking to the real CT019138 and are what `usb.md` was
reverse-engineered from. They live outside the repository (`~/lab/BioRad/`), so this is a by-hand
check rather than part of `npm test`: `tools/emucheck.mjs` ([`tools/emucheck.md`](../tools/emucheck.md))
decodes a capture losslessly, pairs every channel-1 command with its reply, drives the emulator with
the same commands on a clock advanced to the capture's own timestamps, and reports every reply that
differs and every `STATUS?` edge each side passed through. **Re-run it whenever the emulator's
command handling changes**, and fold what it finds back into Appendix A.

Run on 2026-10-14 against both captures:

| | `usb-basic` | `usb-run` |
|---|---|---|
| command/reply pairs | 587, over 36 verbs | 1,595, over 34 verbs |
| result codes | every one `0000`, both sides | every one `0000`, both sides |
| reply shapes | identical, every verb | identical, every verb |
| `STATUS?` | 19 fields; the same 11 populated | 19 fields; the same 16 populated, phase by phase |
| byte-identical | every identity query, every `GETFILE` (nine files, one of them 406 KB in seven messages), every listing of `Real-Time Data` and `Logs` | every identity query, the whole authoring sequence, every upload |
| run edges | no run; lid `OPENING`→`OPEN`→`CLOSING`→`CLOSED` in the same order, within 1.4 s | **the same 10 run edges in the same order**, each within 3.4 s of the instrument's — the run appearing on the very same poll (re-run 2026-10-15 with the measured timing model of §5; 8 s before it) |
| commands the emulator rejects | none | none |
| commands the emulator accepts that the instrument refused | none — the instrument refused nothing | none |

**What the comparison corrected in the emulator**, each now a test:

- **The lid takes time.** `LID OPEN` was answered with `OPEN` on the next poll; the instrument
  reports `OPENING` for ~18 s first, and `CLOSING` for ~9 s after `LID CLOSE`
  (`schedule.ts`'s `LID_OPENING_MS`/`LID_CLOSING_MS`, from both captures).
- **`PROCEED` does not move the elapsed clock.** The emulator jumped field 8 to the end of the
  skipped step; the instrument read 37.77 s on the step after a skipped 180 s hold. Field 8 is wall
  time since the protocol started, and only field 10 is re-planned (`usb.md` §3.2).
- **`\Storage Card\Real-Time Data` and `\Storage Card\Logs` exist** (§4). The emulator
  answered "no such directory" to both; the first holds a `.zpcr` per completed run.
- **A reply over 65,530 bytes is split** (§4). The emulator framed a 406 KB file as one message,
  which the real wire cannot carry.

**What it leaves, and why**, all recorded rather than papered over:

- **The start window and the step timing** were the two things this comparison left as a model
  when it was first run: a 6 s window against `usb-run`'s 10.7 s, and a constant 10 s ramp against
  a real 11 s up and 15 s down, enough that `usb-run`'s `GETFILE` of `Read00001.Plateread` arrived
  3 s before the emulator's read existed. Both are now measured models — a start window per kind of
  run, ramps from the distance, the preheat from the lid (§5) — fitted to `usb-run` and both
  recorded sessions together, and held to the qPCR recording's timings in `npm test` (§10.1).
  Re-run `emucheck` to see where `usb-run` now lands.
- **`CurrentRun`'s listing order differs.** The instrument listed the run's own `runlog.xml`,
  `RunInfo.xml`, `ProtocolRunDefinition.txt` first and the calibration files after, all the
  `_BR Clear` set before the `_BR White` set; the emulator lists in write order. Same names, same
  count; §10.1's `listing-order` entry.
- **The lid in `usb-run` was closed by hand**: three `LID OPEN` commands, no `LID CLOSE`, and the
  instrument reporting `CLOSING`→`CLOSED` anyway. The emulator's lid moves only on command, so the
  run capture's edge table ends two rows short and the script exits 1 on it. That is the operator,
  not a drift.
- **`VOLUME?` answered `10` where the emulator says `25`**: the value the instrument was last set
  to. The emulator's default is the one the committed recordings used.
- **The run report's name is the emulator's own.** It carries the run's start by the emulator's
  clock, and `emucheck` does not tell the emulator when the capture was taken, so CFX Manager's
  `GETFILESIZE`/`GETFILE` of `20260731_213926_CT019138_SINGLETEST.alf` by name finds nothing —
  the one `shape` difference in `usb-run`, and a fact about the harness, not the emulator.
- **Two replies in `usb-basic` ran one command behind** after a `TESTMODE 3`: an `*IDN?` answered
  with a bare `0000` and the next with four raw bytes. A capture artefact of pairing, not
  something to imitate.

**And the thing neither capture can do**: like §10.1's session, the instrument was never asked
anything it refused, so every rejection the emulator makes is still a guess (Appendix A).

### 10.3 End to end

A run the emulator produced parses, analyses and renders exactly as a real run's `.zpcr` does. If
the app cannot tell the two apart, the emulator is doing its job.

**Two things that agreement does not prove.** First, the emulator and `CfxDevice` were written from
the same document, so a shared misreading of `usb.md` agrees with itself — only live hardware
settles the protocol, and the emulator retires no claim in `usb.md`. Second, **the emulator must
never be more permissive than the instrument**: a command the real one rejects has to be rejected
here, or the app grows a dependency on leniency that fails in the lab. Where we do not know whether
the real one rejects something, that is an *invented* answer and Appendix A marks it as one.

**How far it reaches, stated plainly: two *replayable* sessions in `npm test` — a heat-block run
and a 45-cycle qPCR run — and CFX Manager's two-cycle qPCR run compared by hand** (`usb-run`, §10.2,
which passes through the same ten edges in the same order). So §7's read-collection sequence is
measured *and* re-checked on every `npm test`. The melt path has neither a capture nor a log, and
nothing has recorded a cancel or a pause through this app.

## 11. Unwitnessed cases — the standing list

Behaviours the emulator implements that have **never been compared against a live device**. Each
entry is a test waiting for its input: when a log for one arrives, add it to the fidelity
comparison (§10.1), fix whatever it contradicts, and strike the entry. **Anyone adding a behaviour
to the emulator adds its entry here in the same commit, unless they have a recording of it.**

| case | what would settle it |
|---|---|
| A melt run's traffic | a `.zpcr` with a `usb-traffic.bin` from a melt |
| Cancel **inside** the start window | a recorded session that cancels before the run shows — within ~5.5 s of `RemoteRun`, or ~10.7 s for a run with plate reads |
| Cancel **outside** it, mid-`PLATEREAD` | `usb-cancel` covers the abort; the wait-for-the-read-to-end path is prose |
| Pause / resume | implemented from `usb.md` §7.9's description alone |
| A run started at the touchscreen, then connected to | the app's "found a run already in progress" path |
| A mid-run disconnect and reconnect | the case that exposed §3's parked-read bug |
| An upload that fails its CRC | nothing has ever observed a failed `GETFILECRC` |
| `SetDateTime` with a malformed argument, or its effect on the stamps | the capture shows one well-formed send and its `True`; the emulator accepts anything and records it (`clockSettings`) without moving its own clock, whose files take their stamps from `startedAt` |
| Any non-zero result code | see Appendix A — the failure code itself is invented, and §10.1's session never provoked one |
| **When the staging GUID disappears** | it is gone by the end of a run and present right after its upload; nothing observed the moment between (§10.1) |
| **How fast the block cools after a finish** | three falls of under 3 s each (0.15–0.44 °C/s just after the end, `usb.md` §7.6); the emulator's `BLOCK_COOL_TAU_S` (150 s) is a fit to them, and nothing has watched a block for the minutes after. The lid's 1 300 s is one measurement over 42 minutes, and its first seconds fall faster than that |
| **Exactly when the acknowledgement releases the run** | named at +0.05 and +0.21 s, no `ended` at +0.32 s, the empty idle by +2.75 s (`usb.md` §7.6); the emulator releases at 1.5 s, the middle of that bracket, and writes `ended` and the `.alf` in the same instant. Whether the files land with the release or a little after it is unobserved — a session that polls `STATUS?` and lists the folder every 100 ms after its `CANCEL` would settle it |
| **The register-97 finish** | one finish in three reported `IDLE` with register 97 for a poll before the 32 (`usb.md` §3.2); another, polled 0.31 s after its end, did not. Not emulated. A recording that polls fast across a finish would show whether it is a timing window or something about the run |
| **Field 2 after a loop, or in a second loop** | measured through one `GOTO` loop: `1` until the `GOTO` runs, the total after. The emulator puts it back to `1` once a loop is left and takes the next `GOTO`'s total for the next loop — a melt after an amplification would show whether either is right |
| **The lid's first seconds of heating** | the S187 lid read 34.1 °C at the last idle poll and 37.7 °C at the first run poll, 1.5 s later — far faster than its 0.455 °C/s thereafter. The emulator heats it linearly from where it sits, so a run from a cold lid comes out a few seconds long (the heat-block session, §10.1). The fidelity replay seeds the lid at the preheat's own start instead |
| **When `Real-Time Data` and `Logs` gain their files** | both directories exist and hold a completed run's `.zpcr`/`.txt` and the instrument's logs (§4, measured); nothing shows the moment a finished run's `.zpcr` is written there, or whether an acknowledgement is what writes it. The emulator never writes either; they hold what `initialFiles` seeds |
| **`PROCEED` during the lid preheat** | the emulator skips the first step before its clock has started; the instrument's answer is unobserved, and a no-op is as plausible |
| **A one-step loop body, and nested loops** | `GOTO 1,3` straight back to the step before it counts its passes the way `protocol.md` §4 says it must (tested); a loop *inside* a loop restarts the inner count on paper but what the `.alf`'s repeat column and `STATUS?`'s cycle fields (2 and 3) do on hardware is unmeasured |
| **An abort while paused** | the pause's span is kept in the report's clocks (tested); `usb.md` §7.8 lists `CANCEL` on a paused run as itself untested |
| **The lid moved by hand** | `usb-run` shows `CLOSING`→`CLOSED` with no `LID CLOSE` sent; the emulator's lid moves only on command |
| **Listing slot reuse** | §10.1 shows a rewritten file keeping its place and the newest GUID taking the freed slot at the end. Whether that is FAT entry reuse or something else is a guess, so the emulator has not been changed to imitate it |

The length of this list is the honest answer to "how much does a green emulator test prove?".

## 12. Future work

- **Record the logs in §11.** Every lab run with "save log" on is another witness; the fidelity
  comparison takes a list of recordings (§10.1, "Adding a recording"), so each new one should join
  it rather than be checked once by hand. The most wanted: a melt, a cancel, and a session that
  polls fast across a finish.
- A `tools/` CLI that points `cfx.mjs` at an emulator instead of a device. Easy on this API,
  nothing needs it yet.
- Emulating the channel-0/2 traffic, *if* `usb.md` §4 ever becomes understood enough that it would
  be reproduction rather than invention.

---

## Appendix A — measured, derived, invented

Every reply the emulator gives is one of three things, and which one decides what a passing test
proves. **Measured**: a recording or capture shows the instrument answering exactly this.
**Derived**: the shape is measured and this instance is filled in — a status register with our own
temperatures in it. **Invented**: nothing was ever observed and we chose a plausible answer.

A test that passes against an *invented* reply proves the app handles **our guess**.

### Measured

`*IDN?` and the `deviceInfo` query block; `STATUS?`'s twenty fields and their meanings (§3.2);
`RTSTATUS?`'s shape; the `GETFILESLEN`+`LISTALLFILES` pairing and its argument quirk; the two
binary listing replies; `GETFILESIZE`/`GETFILE`/`DELFILE`; the upload cycle and its CRC; the
authoring sequence; `RemoteRun` as the start; plate reads appearing at step end; the §7.6 hold and
what the acknowledgement releases; the start window swallowing a `CANCEL`; a thermal-only run
writing no folder; the `.alf`'s structure, including that an aborted run's report is byte-identical
in shape to a completed one's.

§10.1's replay adds a second, independent witness for much of that list — the whole identity
block, `DELFILE`'s missing-file reply, the upload cycle including the CRC computed over the bytes
that arrived, `ADDCYCLES 0`, a thermal-only run's ~6 s start window, the status register's `104`/`96`/`97`/
`32`, field 15's step count (`4` for three `TEMP` steps and an `END`), the preheat holding every
clock at zero, and a thermal-only run leaving its folder untouched from first command to last. It
also **measures two things that had been guesses**: the run descriptor's name mangling (spaces
become underscores before the eight-character cut), and which commands terminate their reply with
CRLF — the second of which the emulator still does not imitate (§10.1).

§10.2's two captures add a third witness — CFX Manager's own conversation, 2,182 exchanges — and
measure, for the first time: the lid's `OPENING` (~18 s) and `CLOSING` (~9 s) states and their
durations; that `PROCEED` re-plans field 10 without moving field 8; a start window of ~10.7 s
beside the 6.1 s measured live; a `GETFILE` over 65,530 bytes arriving as consecutive messages of
that length; the `Real-Time Data` and `Logs` directories and what they list; `TESTMODE`,
`SETAPILOGLEVEL`, `FRONTENDLOCKED`, `BLOCKID`, `SetDateTime`, `GETSIPOSTERRORS`, `GETTOTALRAM`,
`GETPOS?`, `SUPERLOCKDOWNMODE?` and `ENABLERT?` answering exactly as the emulator does; and the
whole of `usb-run`'s ten run edges in the emulator's order.

§10.1's qPCR session is the first witness of a qPCR run executing, and measures what had been
guesses or single samples: **every duration** — the start window per kind of run, the preheat as
a function of the lid, the ramp rates up and down, the plate read; **field 2** as the loop's total
once its `GOTO` has run; **field 9** reading the hold, as field 12; the at-target bit trailing a
setpoint change; **`ProtocolRunDefinition.txt`'s CRLF**; `lastplatereadstatus` — `(4, 45, 45, 0)`
after `GOTO 2,44`, byte for byte what the emulator writes, so its field meanings (step, pass, read
count) are confirmed; and the acknowledgement's **release** lagging the `CANCEL`.

### Derived

The `.alf`'s own content (generated from the schedule that ran); the run folder's marker files;
block and lid temperature *values* at each moment; elapsed and remaining seconds; the run's
timestamps; `RunInfo.xml`'s `RunStartTime`, `DataFile` and `RunDefinition` (§7 — the shapes are
the recording's, `DataFile`'s name sanitizing is a guess from one example). Also derived, from
measurements that bracket rather than fix them: `RELEASE_MS`, the middle of the 0.32–2.75 s the
release is known to fall in; `AT_TARGET_LAG_MS`, from how often a 1.5 s poll caught the lag; the
two cooling time constants (§11); and one heating rate for the lid, where the three runs measured
spread 0.444–0.469 °C/s.

### Invented — nothing observed

- **The failure code itself: `0001`, bare.** No capture or live session has ever produced a
  non-zero result code. Every rejection below therefore has an invented *form* as well as an
  invented *trigger*.
- **That an unrecognised command is rejected at all**, and specifically: `ADDCYCLES <n≠0>`; a
  `MELT` directive; `<remote start> True`; `<sierra mode> False`; a second `RemoteRun` while a run
  is held; a `RemoteRun` with nothing authored; `GETFILESIZE`/`GETFILE`/`GETFILECRC` on a missing
  file; `COMPUTEFILECRC` with nothing staged; a malformed `RemoteRun`/`LID`/`VOLUME`.
- The *shape* of the block's temperature through a ramp — linear between measured endpoints — and
  of the lid's through the preheat; the lag factor on status field 16. §10.1's
  session measures field 16 under `METHOD BLOCK` and it is *not* a lag: it mirrors the block
  through a ramp and reads the setpoint at target (`usb.md` §3.2). The lag is measured under
  `CALC`, which is the method the emulator applies it to; the `BLOCK` case is still the lag model,
  and so still a guess.
- **Emitting no reply terminator.** Measured to be wrong per command (§10.1) and left alone
  deliberately: imitating it for the 34 verbs the recording witnesses would mean inventing the
  rule for every verb it does not.
- `RTSTATUS?`'s shuttle values (18.31 idle / 30 preheating / 45.2 running) and a constant ambient
  of 26.
- Listing replies for paths outside `\Storage Card`. (`\Storage Card` itself answering "empty" is
  measured; `\Nonexistent` is measured; the general rule between them is extrapolated.)
- The staging GUID's shape — a deterministic counter, not random.
- `RunInfo.xml`'s `Identifier` — a hash of the request time and run name, shaped like the real
  GUID but generated nothing like it (§7). Unique per run, which is all a host relies on.
- The `.alf` step line's field 1 (`-1`) and field 4 (`.00`), written as observed but not understood.
- `CANCEL` on an idle instrument answering `0000`.
- **What `Real-Time Data` and `Logs` hold** — whatever `initialFiles` seeds, and nothing a run
  adds. Their existence and what the real ones list are measured (§4); when the instrument writes
  there is not (§11).
- *When* `CurrentRun` is cleared at the start of a new plate-read run. That it is cleared is now
  measured, in progress over the first ~4.4 s after `RemoteRun` (`usb.md` §7.4, "The folder is
  cleared as the run starts"); the emulator clears it all at once as the run becomes visible —
  the latest the real clear could end, chosen so that a host depositing inside the start window
  loses its files here as it can on the instrument. Which files a real clear spares is inferred.
- The response header bytes `01 00 00 00 …` on every text reply (measured only for the
  `passThrough` case).

## Appendix B — what writing this corrected in `usb.md`

Building a producer for a format is a stricter reading of it than building a consumer, and two
claims did not survive:

- **§5.2's `.alf` filename.** The report is not named for the run "in full": the name is uppercased
  and cut to **twelve** characters. `Single Step RT-QPCR` → `SINGLE_STEP_`, `YouSeq_RP_validation`
  → `YOUSEQ_RP_VA`, both exactly 12. The rule looked whole only because the third witness,
  `singletest`, is ten characters and so was never cut.
- **§7.5 against §7.6/§7.8.** §7.5 lists `ended` and `ProtocolName.txt` as appearing "at the
  finish", while §7.6 and §7.8 measure them appearing only after the acknowledgement. The later
  measurement is the one implemented. §7.4 separately measures that a `RemoteRun`-started run never
  receives a `ProtocolName.txt` at all, which §7.5's list also contradicts.

Two more came out of §10.1's replay, where the recording is the authority:

- **§7.3's `<run name>`, twice.** `STATUS?`'s eight-character truncation also replaces
  filename-hostile characters: `YouSeq RT - S56` → `"YOUSEQ_R"`, not `"YOUSEQ R"`. And §7.3 still
  described the report's filename as carrying the name "in full", which §5.2 had already corrected
  to twelve characters; the stale sentence is gone.
- **§3.2's field 16.** Under `METHOD BLOCK` it is not a modelled sample temperature at all — it
  mirrors the block through a ramp and reads the setpoint once the block arrives. The lag §3.2
  measures is a `CALC` behaviour.

Two questions the document does not answer, which this emulator had resolved by applying §2's own
rules — and which the recording has now answered the other way:

- **Whether a reply payload carries a `\r\n` terminator.** It depends on the command: nineteen of
  the thirty-four verbs in §10.1's session end their reply CRLF and the rest end bare. The
  emulator emits none.
- **Whether `GETFILE` sets `passThrough`.** It does not — a printable file comes back as an
  ordinary text message. The emulator sets it.

And four from §10.2's replay of the two captures, where the capture is the authority:

- **§5's "`\Storage Card` contains nothing but `CurrentRun` and `PCRunReport`."** The live probe
  that established it could not see directories at all. `usb-basic` lists two more — `Real-Time
  Data`, with a `.zpcr` and a `.txt` per completed run, and `Logs` — and downloads from the first.
- **§7.8's start window.** "~6 s is the one measured figure" is now two: 6.1 s live and ~10.7 s in
  `usb-run`. A client's allowance has to cover the larger.
- **§3.2's field 17** gains durations: `OPENING` ~18 s, `CLOSING` ~9 s, and both reported when the
  lid is moved by hand with no command sent.
- **§5 gains the split download**: a file over 65,530 bytes arrives as several messages, which
  nothing in `usb.md` said and `CfxDevice.getFile` does not yet handle.

And five from §10.1's qPCR session:

- **§7.5 and §7.6's "the last read, `ended` and the `.alf` appear in the same moment."** The last
  read does; `ended` and the `.alf` come with the release, up to seconds later. §7.6 now measures
  the gap, and §7.7's sequence waits for it.
- **§3.2's field 2**, "not decidable from one run", is decided: the loop's total, once its `GOTO`
  has run.
- **§3.2's field 10**, whose shortfall "keeps compounding" was untested: it does, ~7.9 s a read,
  six minutes over 45 cycles.
- **§7.3's start**: one ~11 s window and one ~180 s preheat became a window per kind of run and a
  preheat that depends on the lid.
- **§3.2's field 7** gains bit 0 trailing a setpoint change, and register 97 at a finish.
