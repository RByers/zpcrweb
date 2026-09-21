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
- `close()` **rejects** every parked read and drops anything queued, because WebUSB rejects an
  in-flight `transferIn` when the handle closes and `CfxDevice`'s pump reads that rejection as
  "the handle is gone". Without it a disconnect leaves a dead client parked on the endpoint and
  the *next* client's first answer is delivered to the corpse. See §10 — this was a real bug, and
  only a browser found it.

## 4. The filesystem

`emulator/filesystem.ts` holds a path→bytes map and the commands of `usb.md` §5, including the
quirks that make the real one awkward:

- **`LISTALLFILES` ignores its own path argument** and replays whatever the preceding
  `GETFILESLEN` buffered, which is why `CfxDevice` holds the channel across the pair.
- The binary `GETFILESLEN` replies — `7,0,9,0` for an empty directory, `4,0,9,0` for one that
  isn't there — rather than a text code.
- The five-command upload cycle (`DELFILE` → `CRCSENDFILE` → `COMPUTEFILECRC` →
  `GETFILESLEN`+`LISTALLFILES` → `GETFILECRC`), with `crc.ts`'s byte-interleaved XOR.

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
| qPCR | `samples/20260807-YouSeq_RT_-_S56.zpcr` (45 reads) |
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
scales time; `#mock=max` is the accelerated clock, which is what the browser checks use. The
emulator is built once per page, not per connection, so disconnecting is unplugging a cable: the
run goes on running and connecting again finds it mid-run.

## 10. How it is validated, and how far

Three checks, in decreasing strength:

1. **Message-for-message against a real session.** `samples/20260807-YouSeq_RT_-_S56.zpcr` carries
   a `usb-traffic.bin` of a complete run — connect, author, start, watch, finish. Replaying its
   command lines at the emulator and comparing reply *shape*, result code, `STATUS?` field
   population and the order of edges is the closest thing to a ground truth this project has.
2. **Against the two USBPcap captures**, `usb-basic` and `usb-run`, which are CFX Manager talking
   to the real CT019138 and are what `usb.md` was reverse-engineered from. They live outside the
   repo, so this is a by-hand check rather than part of `npm test`.
3. **End to end**: a run the emulator produced parses, analyses and renders exactly as a real
   run's `.zpcr` does. If the app cannot tell the two apart, the emulator is doing its job.

**Two things that agreement does not prove.** First, the emulator and `CfxDevice` were written from
the same document, so a shared misreading of `usb.md` agrees with itself — only live hardware
settles the protocol, and the emulator retires no claim in `usb.md`. Second, **the emulator must
never be more permissive than the instrument**: a command the real one rejects has to be rejected
here, or the app grows a dependency on leniency that fails in the lab. Where we do not know whether
the real one rejects something, that is an *invented* answer and Appendix A marks it as one.

**How far it reaches, stated plainly: one recorded session, of one kind of run.** The melt and
heat-block paths — two of the three kinds the emulator covers — have no recorded traffic at all.
Nothing validates them.

## 11. Unwitnessed cases — the standing list

Behaviours the emulator implements that have **never been compared against a live device**. Each
entry is a test waiting for its input: when a log for one arrives, add it to the fidelity
comparison (§10.1), fix whatever it contradicts, and strike the entry. **Anyone adding a behaviour
to the emulator adds its entry here in the same commit, unless they have a recording of it.**

| case | what would settle it |
|---|---|
| A melt run's traffic | a `.zpcr` with a `usb-traffic.bin` from a melt |
| A heat-block run's traffic | the same for a thermal-only run — note it writes no run folder, so the log has nowhere to go but the console's download |
| Cancel **inside** the start window | a recorded session that cancels within ~6 s of `RemoteRun` |
| Cancel **outside** it, mid-`PLATEREAD` | `usb-cancel` covers the abort; the wait-for-the-read-to-end path is prose |
| Pause / resume | implemented from `usb.md` §7.9's description alone |
| A run started at the touchscreen, then connected to | the app's "found a run already in progress" path |
| A mid-run disconnect and reconnect | the case that exposed §3's parked-read bug |
| An upload that fails its CRC | nothing has ever observed a failed `GETFILECRC` |
| Any non-zero result code | see Appendix A — the failure code itself is invented |

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
- The block/lid/sample temperature curves, and the lag factor on status field 16.
- `RTSTATUS?`'s shuttle values (18.31 idle / 30 preheating / 45.2 running) and a constant ambient
  of 26.
- Listing replies for paths outside `\Storage Card`. (`\Storage Card` itself answering "empty" is
  measured; `\Nonexistent` is measured; the general rule between them is extrapolated.)
- The staging GUID's shape — a deterministic counter, not random.
- `lastplatereadstatus`'s four int32s, read off one melt run's `(9, 61, 101, 0)`. The field
  meanings are a guess.
- The `.alf` step line's field 1 (`-1`) and field 4 (`.00`), written as observed but not understood.
- `CANCEL` on an idle instrument answering `0000`.
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

Two questions the document does not answer, resolved here by applying §2's own rules: whether a
reply payload carries a `\r\n` terminator (the emulator emits none), and whether `GETFILE` sets
`passThrough` (it does).
