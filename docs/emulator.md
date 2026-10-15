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

It is also how the Instrument view gets built without an instrument on the desk (`#mock`, §9).

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
and refuses one the instrument doesn't have. The app's `#mock` seeds `Real-Time Data` with three
bundled `.zpcr`s, all over 64 KB — real runs, so nothing in them is invented — and leaves the
`.txt` beside each out, since what it holds has never been read.

## 5. The run

`emulator/schedule.ts` turns a protocol into a timetable and `emulator/run.ts` executes it, both
over `runDefinition.ts`'s `walkProgram` — the same loop-walking the rest of the library uses, so
`GOTO` semantics exist in one place rather than two.

The sequence is `usb.md` §7's, in order: `PROTOCOL 'PCRUN'` + directives + `END` to author,
`RemoteRun` to start (and **only** `RemoteRun` — `PROCEED` skips a step, it does not start
anything), `ADDCYCLES 0` as ordinary setup, then the files deposited *after* the run is already
cycling. What follows:

- A `Read0000N.Plateread` appears when its `PLATEREAD` step **ends**, not when it begins.
- **The last read is not listable until the run is acknowledged** (§7.6). A finished protocol
  leaves `STATUS?` reporting `IDLE` with the run's name still attached — the instrument is
  *holding* the run — and `CANCEL` releases it, at which point the final read, the `ended` marker
  and the `.alf` all appear together.
- `CANCEL` therefore means two different things depending on when it arrives, and inside the
  ~6 s start window it is answered `0000` and **ignored** (§7.8).
- `PAUSE`/`RESUME` freeze and resume the run's clock.
- **A thermal-only protocol writes no run folder at all** (§7.10). Its entire output is the `.alf`.
  That asymmetry is load-bearing: it is what `RunPlan.producesRunFile` exists for, and the app's
  report-only path had never been exercised before.

`emulator/report.ts` writes the `.alf`, generated from the schedule that actually ran rather than
copied from a recording — a report that described a different run would be worse than none.

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
- `RunInfo.xml`, `runlog.xml` and the `.Dcal` set are carried verbatim from the recording, so they
  describe the **recorded** run, not the emulated one.

## 9. Using it

**Node** — see `packages/core/test/emulator.test.ts` for the full shape:

```ts
const emulator = createCfxEmulator({ data: recordedRunData(archive), clock: acceleratedClock() });
const device = new CfxDevice(emulator);
await device.open();
await device.startRun(planRun({ runDefinition, plate, name }));
```

**Browser** — `#mock` in the URL (`README.md`'s hash-key list). The connect button reads
"Connect (mock USB)" and the rail says outright that nothing here is an instrument. `#mock=60`
scales time; `#mock=max` advances a step per poll and is what the browser checks use. (The app
runs its own `switchableClock` — `apps/web/src/state/mockInstrument.ts` — rather than core's
`acceleratedClock()`, so that changing speed mid-run never has to rebuild the instrument and lose
the run inside it. Same contract, same rebasing rule.) The
emulator is built once per page, not per connection, so disconnecting is unplugging a cable: the
run goes on running and connecting again finds it mid-run.

## 10. How it is validated, and how far

Three checks, in decreasing strength.

### 10.1 Message-for-message against a real session

`samples/20260807-YouSeq_RT_-_S56.zpcr` carries a `usb-traffic.bin` of a complete session against
CT019138 — 10 780 messages, connect → author → start → watch → finish → pull, recorded by this app
itself. `packages/core/test/emulatorFidelity.test.ts` replays its **5 390 host→device commands**,
in order, at an emulator whose clock is advanced to the recording's own timestamps, and compares
every answer with the instrument's. It is the only check in the suite with an outside witness.

**What the recorded run actually is matters, and it is not what this document first assumed.** The
session's protocol is `METHOD BLOCK` with three `TEMP` steps and **no `PLATEREAD`** — a
**heat-block run** (`usb.md` §7.10), an hour of reverse transcription. The 45 plate reads and the
`.alf` it pulls at the end belong to the *previous* qPCR run, whose files were still sitting in
`\Storage Card\CurrentRun` because a thermal-only run writes no run folder. So this log witnesses
the thermal run path and the whole file-transfer path; **a qPCR run's own execution — reads
appearing as their steps end — is not witnessed by it**, and neither is a melt, a cancel or a
pause.

What is compared, per command:

| | |
|---|---|
| reply shape | value + `;` + code, a bare code, or raw bytes — per command, against the instrument's |
| result code | exactly. Every code in this session is `0000`, on both sides |
| whole replies | 213 of the 222 non-poll replies match **byte for byte**, GUIDs and the terminator aside — including 82 whole-file transfers (45 plate reads, 32 `.Dcal`s, the run log, the report) and the three `GETFILECRC` checksums computed over them |
| `STATUS?` | 20 fields, and **which** of them are populated, per phase of the run — the values cannot match, so they are checked for plausible range and for an elapsed clock that only advances |
| the run descriptor | exactly: field 6 is built from `RemoteRun`'s own operands, so both sides must spell it the same |
| the sequence | the run's edges — idle → preheat → each step's ramp and hold in order → the finished-and-held state — as a *sequence*, never per poll |

Every remaining difference is printed by the test rather than tolerated silently, and anything
outside the list it knows about fails the run naming the command. What it found, and what each
one means:

| difference | what it is |
|---|---|
| **Reply terminators** | the instrument ends some replies `\r\n` and others bare, *per command*: `*IDN?`, `BASESN?`, `ALPHASN?`, `ALPHAID?`, `BLOCKDESC?`, `BLOCKCOUNT?`, `CPLD?`, `VOLUME?`, `LIDFORCE?`, `LIDVERSION?`, `LIDBVERSION?`, `ERRORS?`, `PROTOCOL`, `METHOD`, `HOTLID`, `TEMP`, `END`, `ADDCYCLES` and `CANCEL` carry CRLF; `STATUS?`, `RTSTATUS?`, `RemoteRun`, `FrontEndSoftware?`, `SUPERLOCKDOWNMODE?`, `GETFREESPACE`, `GETTOTALRAM` and every file command do not. The emulator emits none. `parseResponse` strips either, so nothing in the client notices — but a client that compared a reply to `"0000"` would pass here and fail in the lab |
| **`GETFILE` is not `passThrough`** | printable files come back through this app's own recorder as *text*, which only happens when the response header's passThrough bit is clear. The emulator sets it |
| **Listing order** | a file deleted and written again keeps its place in the instrument's listing (and the staging GUID always lands last, in the slot the previous one freed — FAT directory-entry reuse, in all likelihood). The emulator's listing moves a rewritten file to the end |
| **Staging GUID lifetime** | the GUID copy `CRCSENDFILE` leaves behind is gone from the instrument's listing by the end of the run. The emulator keeps it until the next upload, so its final listing is one name and 37 bytes longer |
| **The at-target bit can fall back** | one poll of 2 585 reported *not* at target with the hold clock already running — the block had overshot to 30.39 against a 30.0 setpoint. The emulator's at-target bit never falls back once a step has arrived |
| **Run duration** | the emulator's model of this protocol runs ~20 s long (a 168 s lid preheat against this instrument's ~155 s, and 10 s per ramp against ~8 s). Small — except that the session's last `CANCEL` is the acknowledgement of a *finished* run, and 20 s early it is an abort instead, so the emulator's run ends cancelled where the instrument's ended clean |
| **`GETFREESPACE`, GUIDs, temperatures, clocks** | instrument-specific by nature; compared for shape only |
| **Two files** | the archive is not a byte-identical copy of what the instrument held: the app overwrote `zpcrweb.json` during the session, and rewrote the plate `.csv`'s header (`FAM Ch1` → `FAM`) on the way in. The emulator serves what it was handed, so this is a fact about the app, not about the emulator |

One disagreement was a plain bug and was **fixed** rather than recorded: `STATUS?`'s run
descriptor is uppercased, cut to eight characters **and has filename-hostile characters replaced**
— `YouSeq RT - S56` comes back `"YOUSEQ_R"`, not `"YOUSEQ R"`. The report's twelve-character name
already did this; the status copy did not (`usb.md` §7.3, corrected in the same commit).

**And the thing this check cannot do at all:** every result code in the recording is `0000`. The
instrument was never asked anything it refused, so the property Appendix A cares about most —
that the emulator is never *more permissive* than the real thing — has no witness here. All this
proves on that front is that the emulator invents no failure where the instrument succeeded.

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
| run edges | no run; lid `OPENING`→`OPEN`→`CLOSING`→`CLOSED` in the same order, within 1.4 s | **the same 10 run edges in the same order**, each within 8 s of the instrument's |
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

- **The start window is 6–11 s, not 6 s.** `usb-run`'s run appeared 10.7 s after `RemoteRun`
  (±1.4 s of its poll); the live measurement behind `START_WINDOW_MS` was 6.1 s. The emulator keeps
  6 s — a client has to allow for several times either — so its first step ran 4 s longer than the
  instrument's before the operator's `PROCEED` cut it.
- **Step timing is a model.** The emulator's thermal steps came out within −8 s / +4 s of the
  instrument's (its 10 s ramp against a real 11 s up-ramp and 15 s down-ramp), which is enough to
  move a plate read by a poll or two: `usb-run`'s `GETFILE` of `Read00001.Plateread` arrived 3 s
  before the emulator's read existed. The order of events is right; the seconds are not promised.
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

**How far it reaches, stated plainly: one *replayable* session of a heat-block run in `npm test`,
and one qPCR run compared by hand.** `usb-run` — two cycles, two plate reads, a `PROCEED`, the
§7.6 hold and its acknowledgement — has been replayed at the emulator with `tools/emucheck.mjs`
(§10.2) and passes through the same ten edges in the same order, so §7's read-collection sequence
is measured *and* checked. What is still missing is a qPCR log **in the repository**, so that
check runs on every `npm test` rather than when someone remembers to; the captures are the
operator's and stay outside it. The melt path has neither — no capture and no log.

## 11. Unwitnessed cases — the standing list

Behaviours the emulator implements that have **never been compared against a live device**. Each
entry is a test waiting for its input: when a log for one arrives, add it to the fidelity
comparison (§10.1), fix whatever it contradicts, and strike the entry. **Anyone adding a behaviour
to the emulator adds its entry here in the same commit, unless they have a recording of it.**

| case | what would settle it |
|---|---|
| A qPCR run's traffic, *replayably* | a `.zpcr` with a `usb-traffic.bin` from a run with a `PLATEREAD` in it. The behaviour is measured and checked by hand (§10.2 replays `usb-run`), but §10.1's in-repo session only pulls a qPCR's *files* without watching one execute, so `npm test` never re-checks it |
| A melt run's traffic | a `.zpcr` with a `usb-traffic.bin` from a melt |
| Cancel **inside** the start window | a recorded session that cancels within ~6 s of `RemoteRun` |
| Cancel **outside** it, mid-`PLATEREAD` | `usb-cancel` covers the abort; the wait-for-the-read-to-end path is prose |
| Pause / resume | implemented from `usb.md` §7.9's description alone |
| A run started at the touchscreen, then connected to | the app's "found a run already in progress" path |
| A mid-run disconnect and reconnect | the case that exposed §3's parked-read bug |
| An upload that fails its CRC | nothing has ever observed a failed `GETFILECRC` |
| `SetDateTime` with a malformed argument, or its effect on the stamps | the capture shows one well-formed send and its `True`; the emulator accepts anything and records it (`clockSettings`) without moving its own clock, whose files take their stamps from `startedAt` |
| Any non-zero result code | see Appendix A — the failure code itself is invented, and §10.1's session never provoked one |
| **When the staging GUID disappears** | it is gone by the end of a run and present right after its upload; nothing observed the moment between (§10.1) |
| **What the block reports after a finish** | this instrument was still reporting 94.42 °C when its 95 °C run finished; the emulator drops to ambient at once. How fast a real block falls is unmeasured |
| **How long the run stays named after the acknowledgement** | one poll after the acknowledging `CANCEL` the instrument still reported `"YOUSEQ_R",BLOCK,OFF` with register 32; the emulator returns to the empty idle immediately. One sample is not a duration |
| **When `Real-Time Data` and `Logs` gain their files** | both directories exist and hold a completed run's `.zpcr`/`.txt` and the instrument's logs (§4, measured); nothing shows the moment a finished run's `.zpcr` is written there, or whether an acknowledgement is what writes it. The emulator never writes either; they hold what `initialFiles` seeds |
| **`PROCEED` during the lid preheat** | the emulator skips the first step before its clock has started; the instrument's answer is unobserved, and a no-op is as plausible |
| **A one-step loop body, and nested loops** | `GOTO 1,3` straight back to the step before it counts its passes the way `protocol.md` §4 says it must (tested); a loop *inside* a loop restarts the inner count on paper but what the `.alf`'s repeat column and `STATUS?`'s cycle field do on hardware is unmeasured |
| **An abort while paused** | the pause's span is kept in the report's clocks (tested); `usb.md` §7.8 lists `CANCEL` on a paused run as itself untested |
| **The lid moved by hand** | `usb-run` shows `CLOSING`→`CLOSED` with no `LID CLOSE` sent; the emulator's lid moves only on command |
| **Listing slot reuse** | §10.1 shows a rewritten file keeping its place and the newest GUID taking the freed slot at the end. Whether that is FAT entry reuse or something else is a guess, so the emulator has not been changed to imitate it |

The length of this list is the honest answer to "how much does a green emulator test prove?".

## 12. Future work

- **Record the logs in §11.** Every lab run with "save log" on is another witness; the fidelity
  comparison should be re-run against each new one rather than staying pinned to the one file it
  was written for.
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
that arrived, `ADDCYCLES 0`, the six-second start window, the status register's `104`/`96`/`97`/
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

### Derived

The `.alf`'s own content (generated from the schedule that ran); the run folder's marker files;
block and lid temperature *values* at each moment; elapsed and remaining seconds; the run's
timestamps.

### Invented — nothing observed

- **The failure code itself: `0001`, bare.** No capture or live session has ever produced a
  non-zero result code. Every rejection below therefore has an invented *form* as well as an
  invented *trigger*.
- **That an unrecognised command is rejected at all**, and specifically: `ADDCYCLES <n≠0>`; a
  `MELT` directive; `<remote start> True`; `<sierra mode> False`; a second `RemoteRun` while a run
  is held; a `RemoteRun` with nothing authored; `GETFILESIZE`/`GETFILE`/`GETFILECRC` on a missing
  file; `COMPUTEFILECRC` with nothing staged; a malformed `RemoteRun`/`LID`/`VOLUME`.
- **Ramp rate** — 10 s per thermal step. No instrument ever reports one.
- The block/lid/sample temperature curves, and the lag factor on status field 16. §10.1's
  session measures field 16 under `METHOD BLOCK` and it is *not* a lag: it mirrors the block
  through a ramp and reads the setpoint at target (`usb.md` §3.2). The lag is measured under
  `CALC`, which is the method the emulator applies it to; the `BLOCK` case is still the lag model,
  and so still a guess.
- **The block temperature after a finish.** The emulator drops to ambient the moment a run ends;
  the instrument was still reporting 94.42 °C (§11).
- **Emitting no reply terminator.** Measured to be wrong per command (§10.1) and left alone
  deliberately: imitating it for the 34 verbs the recording witnesses would mean inventing the
  rule for every verb it does not.
- `RTSTATUS?`'s shuttle values (18.31 idle / 30 preheating / 45.2 running) and a constant ambient
  of 26.
- Listing replies for paths outside `\Storage Card`. (`\Storage Card` itself answering "empty" is
  measured; `\Nonexistent` is measured; the general rule between them is extrapolated.)
- The staging GUID's shape — a deterministic counter, not random.
- `lastplatereadstatus`'s four int32s, read off one melt run's `(9, 61, 101, 0)`. The field
  meanings are a guess.
- The `.alf` step line's field 1 (`-1`) and field 4 (`.00`), written as observed but not understood.
- `CANCEL` on an idle instrument answering `0000`.
- **What `Real-Time Data` and `Logs` hold** — whatever `initialFiles` seeds, and nothing a run
  adds. Their existence and what the real ones list are measured (§4); when the instrument writes
  there is not (§11).
- **Ramp lengths.** The emulator's 10 s is between the instrument's measured ~11 s up and ~15 s
  down (§10.2); a block's real ramp depends on the distance, and nothing reports a rate.
- Clearing `CurrentRun` at the start of a new plate-read run — derived from "every pulled folder
  holds one run's files", never observed directly.
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
