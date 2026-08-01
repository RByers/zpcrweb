# USB protocol — CFX96 (C1000 / C1000 Touch base)

A CFX96 talks USB as a subsystem of its base unit (the C1000 / C1000 Touch thermal cycler): one
composite-looking device, one vendor-specific bulk interface, and an ASCII command language
riding on top of a small binary frame. This document is what's needed to drive it directly —
open the device, claim the interface, frame a command, and parse the response — without going
through CFX Manager. It covers only what real USB traffic demonstrates.

**Provenance.** Every claim below is derived from two captures taken with USBPcap while CFX
Manager 3.1 talked to a real CT019138 (a C1000 Touch running a CFX96 head): `usb-basic`
(enumeration, lid open/close, idle status polling, no run) and `usb-run` (load a protocol + plate
map, run 2 cycles with 2 plate reads, pull the results). Decoding was done with
`tools/usbpcap_decode.py` (§8), which reassembles each direction's bulk stream into logical
messages before parsing anything — see §8 for why that reassembly step matters. Every field and
byte offset below was checked against the raw pcapng bytes, not assumed; §9 collects the handful
of claims that rest on a single observation rather than a cross-checked pattern.

**This protocol is now implemented, and the implementation has been driven against live
hardware** — see §10. Talking to the same CT019138 confirmed §1's descriptors, §2's framing and
every query in §3 unchanged, and corrected four things the captures alone could not settle:
what `GETFILESLEN` actually returns (§3), that it is a *required prologue* to `LISTALLFILES`
rather than the sanity check it looked like (§5), what the header's `passThrough` bit means
(§2), and what the two binary `GETFILESLEN` replies mean — "empty" and "no such directory", not
"unlistable" (§5). Those are marked **measured live** where they appear.

**§7 is the run.** §1–§5 are the protocol's pieces in isolation; §7 reconstructs the complete
sequence a run is made of — pre-flight, authoring, start, file deposit, plate-read collection,
finish — in the order it actually goes out. Reading it changes two things a reader of §5 alone
would get wrong: the uploaded `.prcl`/`.pltd` are not what starts a run (they arrive after it is
already running), and `PROCEED`/`CANCEL` are "skip a step" and "acknowledge the finished run", not
"start" and "abort".

## 1. Device identity and topology

The instrument enumerates as a single USB device (not a hub with sub-devices) with:

| Field | Value |
|---|---|
| idVendor | `0x0614` (Bio-Rad) |
| idProduct | `0x057B` (C1000 Touch Thermal Cycler) |
| bDeviceClass/SubClass/Protocol | `0x00/0x00/0x00` — unspecified at the device level; the one interface below carries its own class instead |
| bMaxPacketSize0 | 16 (endpoint 0, control transfers only — not the same field as the bulk/interrupt endpoints' max packet size below, which is a separate 64) |

Other Bio-Rad PIDs likely share this same family (C1000 non-touch, CFX Connect, S1000) but weren't
captured here, so their exact values aren't confirmed by this document (§9). A device presenting
`0x0547:0x0080` or `0x0547:0x2131` (Cypress's own default IDs, the bridge-chip vendor this base
unit uses) would be a factory-fresh unit that hasn't had firmware pushed to it yet — that state
wasn't captured either.

The one configuration has one interface, vendor-specific, with three endpoints:

| Endpoint | Direction | Type | Max packet | Interval |
|---|---|---|---|---|
| 2 | OUT | Bulk | 64 | — |
| 6 | IN | Bulk | 64 | — |
| 3 | IN | Interrupt | 64 | 32 ms (`bInterval=0x20`) |

Interface class/subclass/protocol are all `0xFF` (vendor-specific) — no built-in OS class driver
will bind it, which is exactly what a WebUSB `requestDevice` filter on `vendorId: 0x0614` wants.
**Every command and response in both captures went over the two bulk endpoints** (2 OUT / 6 IN);
the interrupt endpoint was never observed carrying data in either capture. It's declared, so don't
assume it's dead — but it isn't part of the request/response path documented here, and everything
in these two captures (idle polling, lid control, full 2-cycle run, plate read pulls) happened
without it.

Both captures show the host fetching this configuration descriptor for the CFX96 itself — a short
9-byte read (just the configuration header, to learn the total length) immediately followed by the
full 39-byte one, right as device address 3 becomes `0x0614:0x057B` (at the very start of
`usb-run`; about 30 seconds into `usb-basic`, once the instrument finishes enumerating). Both reads
return the identical bytes:

```
09 02 27 00 01 01 00 c0 00  09 04 00 00 03 ff ff ff 00  07 05 86 02 40 00 00  07 05 02 02 40 00 00  07 05 83 03 40 00 20
```
— configuration header, one interface (`bNumEndpoints=3`, class `ff/ff/ff`), then the three
endpoint descriptors (`0x86`=EP6 IN bulk, `0x02`=EP2 OUT bulk, `0x83`=EP3 IN interrupt) in the
order shown in the table above.

## 2. The application-layer wire format

Every logical message — the ASCII command shown in §3 as much as the binary traffic in §4 — is a
5-byte header immediately followed by its payload, sent over bulk endpoint 2 OUT (host→device) or
returned over bulk endpoint 6 IN (device→host). This is **not** the USBPcap capture envelope
(that's a separate, standard format the capture tool wraps every USB packet in — see §8) — it's
the application's own framing, present only inside the payload bytes of a bulk transfer.

| Byte | Contents |
|---|---|
| 0 | `handle << 2 \| channel` |
| 1 | `newLine << 6 \| charTimeout << 3 \| msgTimeout` |
| 2 | `ascii << 3 \| textPayload << 2 \| passThrough << 1 \| dummyAdded` |
| 3–4 | payload length, **big-endian** `uint16` |
| 5.. | payload (exactly the announced length) |

This layout was derived directly from the capture: every message in both files decodes cleanly
against it, with the announced length always matching the payload actually delivered. Example,
byte-exact from `usb-basic` (a `*IDN?` query):

```
01 7f 0c 00 07  2a 49 44 4e 3f 0d 0a
```
`handle=0, channel=1` · `newLine=1, charTimeout=7, msgTimeout=7` · `ascii=1, textPayload=1,
passThrough=0, dummyAdded=0` · length=`0x0007=7` · payload = `"*IDN?\r\n"`. The `msgTimeout=7,
charTimeout=7` pair is constant — the same 7/7 values show up in every channel-1 message across
both captures, so it's evidently a fixed value this protocol always uses, not something that needs
to vary.

**Byte 2 differs by direction, and `passThrough` is the bit that matters** (measured live). A host
request sets `ascii` and `textPayload`, giving the `0x0c` above. A *response* leaves both clear —
byte 2 is `0x00` even for an ordinary ASCII reply — so those two flags describe what the sender is
declaring about its own payload, not a property of the message the receiver can rely on.
`passThrough` is the exception and the useful one: the device sets it (byte 2 = `0x02`) exactly
when the payload is **raw bytes rather than text**. `GETFILESLEN "\Storage Card"` is the
reproducible example — `01 00 02 00 04` framing four binary bytes `07 00 09 00`, where every text
reply in the same session came back as `01 00 00 00 <len>`. A client should treat `passThrough` as
the signal to skip response parsing and take the payload as-is.

**Multi-packet messages.** The 5-byte header describes the whole logical message, which can be
much larger than one 64-byte USB bulk packet (max packet size, per §1). Only the *first* USB
packet of a message carries the header; every following packet in the same direction is raw
continuation payload with **no header of its own** — the receiver just keeps reading until it has
accumulated `length` payload bytes total. Observed transfer sizes: the host reads a large file
(§5) in **4096-byte chunks** (its own read-buffer size, not a protocol limit — 64 bytes is the
actual USB max packet size, so a 4096-byte "chunk" is itself many small USB packets coalesced by
the driver stack into one logical bulk read). A `CRCSENDFILE` upload of a several-KB `.pltd`/`.prcl`
was seen going out as a single message with no visible upper bound in these captures — so this
protocol does not appear to impose its own additional chunk-size ceiling beyond what the USB
transport naturally splits into.

**Channels.** The `channel` field is 2 bits (0–3), multiplexing independent logical streams over
the same pair of bulk endpoints. Reassembling each direction's bulk stream into complete messages
(§8) and tallying the result across both captures gives an exact picture of how the four values are
actually used:

| Channel | Messages (`usb-basic` + `usb-run`) | Use |
|---|---|---|
| 1 | 1,188 + 3,191 = 4,379 | ASCII command/response (§3) — every message decodes as a printable, CR-terminated command line |
| 2 | 242 + 32 = 274 | A binary auxiliary stream, still only partially decoded (§4) |
| 0 | 4 + 0 = 4 | Rare — one exchange, repeated twice, only in `usb-basic` (§4) |
| 3 | 0 + 0 = 0 | Never seen as a genuine message in either capture, despite being a representable value |

`handle` was 0 for every one of those 4,657 reassembled messages — either this instrument only
ever hands out handle 0, or CFX Manager never had cause to open a second one in the traffic
captured (§9).

## 3. Channel 1 — the ASCII command language

A channel-1 message's payload is the literal command line: **ASCII, CR-terminated** for a request
(`\r\n` was used consistently in every message captured), no other structure — a plain text
command in, a plain text response out, framed per §2.

**Response shape.** There are two shapes, and which one a command uses depends on whether it has
a value to report at all:

- Commands with something to report — even an empty string, even just a boolean — separate the
  value from the error code with a semicolon: `*IDN?` → `BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0;0000`;
  `WORKING?` → `True;0000`; `ERRORLIST A`, which has nothing to report this run, still sends the
  semicolon with an empty value → `;0000`.
- Pure action commands — the ones with no return-value slot in their response at all, confirmed
  byte-for-byte (`30 30 30 30`, no `3b`) rather than inferred from the rendered text — respond
  with the bare 4-digit code and no separator: `DELFILE`, `PROTOCOL`, `METHOD`, `HOTLID`, `VOLUME`
  (the setter), `TEMP`, `PLATEREAD`, `GOTO`, `END`, `ADDCYCLES`, `RemoteRun`, `PROCEED`, `CANCEL`,
  `LID OPEN`, `LID CLOSE`, `FRONTENDLOCKED`, `TESTMODE`, `BLOCKID`, and `SETAPILOGLEVEL` all responded `0000`,
  never `;0000`. `SetDateTime` is the one exception that looks like this group but isn't: it
  reports success as a value, `True;0000`, because it does have something to report.

`<errcode>` is `0000` for success in every response seen in both captures; neither capture ever
triggered an actual device error, so what a non-zero code looks like is unconfirmed.

Commands actually observed on the wire (this is not a complete command vocabulary — only what
appeared in these two captures), grouped by role:

**Identification and static status** — queried once during startup, not polled again:

| Command | Example response | Notes |
|---|---|---|
| `*IDN?` | `BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0;0000` | manufacturer, model, serial, firmware |
| `SOFTWARE?` | `2.0.231.0;0000` | matches the firmware field of `*IDN?` |
| `FrontEndSoftware?` | `1.102.548.801;0000` | a second, longer version string — front-end/UI software, distinct from `SOFTWARE?` |
| `BASESN?` | `CT019138;0000` | base unit serial, matches `*IDN?`'s serial field |
| `ALPHASN?` | `RN050773;0000` | a second serial number, distinct from the base unit's |
| `ALPHAID?` | `4;0000` | a block/head type identifier; this instrument (a CFX96) reports `4` — the general ID→name mapping wasn't derived from the capture, just this one observed value (§9) |
| `BLOCKDESC?` | `"96FX";0000` | block/plate-type descriptor |
| `BLOCKCOUNT?` | `1;0000` | |
| `CPLD?` | `B;0000` | a firmware/hardware revision letter |
| `DEVICES?` | `0;0000` | unclear what this counts; `0` in both captures |
| `VOLUME?` | `10;0000` | last-set reaction volume, µL |
| `WORKING?` | `True;0000` | |
| `BOOTMODE?` | `False;0000` | |
| `SELFTEST?` | `0;0000` | |
| `ENABLERT?` | `0;0000` | |
| `ERRORS?` | `0;0000` | an error *count* — distinct from `ERRORLIST A`'s error *contents* |
| `GETSIPOSTERRORS` | `true;;0000` | the doubled `;;` is real — an empty middle field between a `true`/`false` flag and the error code |
| `SUPERLOCKDOWNMODE?` | `OFF;0000` | |
| `GETFREESPACE` | `4018397184;0000` | bytes free on storage |
| `GETTOTALRAM` | `96014336;0000` | bytes of RAM |
| `NAME?` | `"";0000` | current run name; empty while idle |
| `LIDFORCE?` | `AUTO;0000` | |
| `LIDVERSION?` | `54;0000` | |
| `LIDBVERSION?` | `236;0000` | |
| `GETPOS?` | `0;0000` | an unidentified position query — the capture doesn't say what it's a position *of* |

**The polling loop** — repeated roughly every second for the life of the connection, in this
order:

| Command | Example response | Notes |
|---|---|---|
| `STATUS?` | idle: `17.04;18.3;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;17.04;CLOSED;0;0000` — mid-run: `60.25;104.9;2;2;TEMP 95.0,10;2;"SINGLETE",CALC,ON;96;110.22;0.00;75.15;2.10;0.00;0;0;6;55.61;CLOSED;0;0000` | block temp, lid temp, two counters that both track the **cycle**, the current step text, that step's **1-based protocol step number**, run name, method, lid state, block count, elapsed... — both examples are the complete response, not truncated. The step number is the field *after* the step text — `PLATEREAD #h3F` reports `4` in a protocol where the plate read is the fourth step, which is one of the two measurements behind `protocol.md` §4. The two counters *before* the step text are not separable from each other in this capture (`protocol.md` §9) |
| `RTSTATUS?` | `18.31;26;;0000` | shorter status, polled alongside `STATUS?` |
| `ERRORLIST A` | `;0000` | polled every cycle in lockstep with `STATUS?`/`RTSTATUS?` |

**Protocol authoring and run control:**

| Command | Notes |
|---|---|
| `PROTOCOL '<name>'`, `METHOD <name>` | names the protocol/method being authored — see §5 |
| `HOTLID <temp>,<shutoff>` | e.g. `HOTLID 105,30` — the second operand is the lid *shutoff* temperature (`protocol.md` §3.2); "ramp" was this table's earlier guess from the wire alone |
| `VOLUME <µL>` | e.g. `VOLUME 25` |
| `TEMP <°C>,<seconds>` | one hold step, e.g. `TEMP 95.0,180` |
| `PLATEREAD #h<hex>` | e.g. `PLATEREAD #h3F` — the **scan mask**: which optical channels to read, and how to sweep the plate. Decoded in §3.1 |
| `GOTO <step>,<count>` | e.g. `GOTO 2,1` — loop back to step 2, 1 more time (2 total passes) |
| `END` | closes the step list |
| `ADDCYCLES <n>` | extends the running protocol's loop; the capture sends `ADDCYCLES 0`, a no-op, as ordinary run setup |
| `RemoteRun "<block>","<lid on>","<remote start>","<name>","<user>","<sample ID>","<sierra mode>","<method>"` | e.g. `RemoteRun "A","True","False","singletest","admin","","True","CALC"` — starts the authored protocol, carrying what the protocol text cannot (`protocol.md` §7) |
| `PROCEED` | **skips to the next step** of a running protocol. Not a start or a resume: it was sent 215 s into a run, while a 3-minute hold still had time left, and the very next `STATUS?` was on the following step — §7.5 |
| `CANCEL` | **acknowledges a finished run**, clearing the run name the instrument keeps holding after the protocol ends; §7.6 has the `STATUS?` transition that shows this, and the run's final `Read0000N.Plateread` is picked up after it. It is presumably also the abort, but nothing here aborts a run in progress |
| `LID OPEN` / `LID CLOSE` | motorised lid control. In `usb-basic` the operator opened and then closed the lid, and the pair appears in exactly that order. Note CFX Manager emits `LID OPEN` **three times** for one open (t=…010.7, …018.5, …026.5) and `LID CLOSE` once — the repeat looks like the UI re-asserting while the lid travels, not three separate requests. `usb-run` has three `LID OPEN` and no `LID CLOSE`, matching an operator who opened it to load a plate and closed it at the touchscreen instead |
| `FRONTENDLOCKED ON`/`OFF` | `ON` appears once in `usb-basic`; `OFF` once, at the very end of `usb-run` |
| `TESTMODE <n>` | e.g. `TESTMODE 3`, issued at the very start of both captures |
| `BLOCKID <n>` | **block identify — flashes that block's indicator**, so an operator can tell which unit is being addressed. `<n>` is the block number; `BLOCKCOUNT?` reports how many exist (1 on a CFX96). Established by correlating the captures against what the operator did: `usb-basic` opens with an indicator flash, then a lid open, then a lid close, and its only `BLOCKID 1` sits at t=…005.2, immediately before the first `LID OPEN` at t=…010.7. `usb-run`, where no flash was performed, contains **no `BLOCKID` at all** despite having the same lid traffic — which is what rules out its being routine setup |
| `SETAPILOGLEVEL <n>` | e.g. `SETAPILOGLEVEL 1` |
| `SetDateTime <mm/dd/yyyy>,<hh:mm:ss>,<AM\|PM>,<tz offset>` | e.g. `SetDateTime 07/31/2026,09:33:04,PM,-04:00` → `True;0000` |

**Filesystem and file transfer** — see §5 for the full upload/download mechanism:

| Command | Notes |
|---|---|
| `GETFILESLEN <dir>` | **The byte length of the `LISTALLFILES` response for that directory** — not a count of entries (measured live; see §5). A `PCRunReport` holding one 39-character name answers `39`; a `CurrentRun` whose listing is 881 characters answers `881`. Also the required prologue to `LISTALLFILES`. |
| `LISTALLFILES <dir>` | comma-separated filenames — **of whichever directory the preceding `GETFILESLEN` buffered, ignoring the path given here** (measured live; see §5) |
| `GETFILESIZE <path>` | byte count |
| `GETFILE <path>` | raw file bytes |
| `DELFILE <path>` | |
| `COMPUTEFILECRC "<path>"` | despite the name, does **not** return a CRC — see §5 |
| `GETFILECRC "<path>"` | `<crc>;0000` |
| `CRCSENDFILE "<crc>*<path>",<raw bytes>` | file upload, §5 — the one command whose payload is *not* all-ASCII |

### 3.1 `PLATEREAD`'s operand — the scan mask

> The rest of the protocol language — every verb in the table above, its operands and its
> meaning — is `protocol.md`. This section decodes the one operand that isn't a temperature or a
> count.

`PLATEREAD` is the one step command whose operand isn't a temperature or a count, and it is the
only place in the whole protocol language where a run says *what it will measure* rather than
*what the block will do*. Two values appear across every capture and every sample in this repo —
`#h3F` and `#h81` — and the second is what makes the field interesting: read as a plain 6-bit
channel mask, `0b1000_0001` selects a seventh channel that a CFX96 does not have.

It isn't a plain channel mask. It is **two fields packed into one byte**:

| Bits | Meaning |
|---|---|
| 0–5 | one bit per optical channel — bit 0 = channel 1 … bit 5 = channel 6 |
| 6 | never seen set |
| 7 (`0x80`) | **sweep mode**: clear = step-and-repeat (stop over each well), set = flyover (scan the plate continuously) |

Which makes the two observed values:

| Operand | Bits | Channels read | Sweep | CFX Manager calls it |
|---|---|---|---|---|
| `#h3F` | `0b0011_1111` | all six | step-and-repeat | "All Channels" |
| `#h81` | `0b1000_0001` | channel 1 only | flyover | fast scan (SYBR/FAM only) |

The wire form is `#h` followed by uppercase hex with no zero-padding, so the operand is one or two
hex digits, not a fixed width.

**What the value is decided by: the plate, not the protocol.** A `.prcl`'s authored step list has
no channel information in it at all — its `PlateReadOption` element carries only the marker
`optionId="PlateReadOption"` (`prcl.md` §2) — and every authored `.prcl` renders the step as
`PLATEREAD #h3F` regardless of what the run will actually do. The real mask comes from the plate
definition's `scanMode` attribute (`pltd.md` §2) and is substituted when the run is started, which
is why the same protocol appears with two different operands in one archive: `#h3F` in the
`.prcl`, `#h81` in the `ProtocolRunDefinition.txt` the instrument recorded for the run
(`prcl.md` §3 flags the discrepancy; this is its explanation). **The recorded `.txt` is the one to
trust** — it is what the instrument was actually told.

**The instrument echoes it back three ways**, which is what makes the decoding checkable rather
than merely plausible:

- `RunInfo.xml`'s `ScanMask` key — the operand in decimal.
- every `.Plateread`'s `CHANNELMASK` field (`plateread.md` §4) — the operand verbatim, same bit
  layout, no reordering.
- every `.Plateread`'s `SCANMODE` field — `0` for step-and-repeat, `1` for flyover, i.e. exactly
  bit 7 of the mask on its own. (An unfortunate name: this `SCANMODE` is the *sweep* mode, and is
  not the plate's `scanMode` attribute, which names the whole configuration.)

And live, on the wire: in `usb-run` CFX Manager sent `PLATEREAD #h3F` as one of the protocol
authoring commands, and while the read was executing, `STATUS?`'s current-step field echoed the
command text back unchanged — `…;1;1;PLATEREAD #h3F;4;"SINGLETE",CALC,ON;…`.

**Evidence.** Across the five `.zpcr` samples committed here (Appendix §9 records what a single
observation does and doesn't settle):

| Sample | Plate `scanMode` | Recorded `PLATEREAD` | `ScanMask` | `CHANNELMASK` / `SCANMODE` | Channels with data |
|---|---|---|---|---|---|
| `20190516…SHORT_QUALIF` | `FirstChannelFastSacn` | `#h81` | 129 | 129 / 1 | channel 1 only |
| `20260725_GRADIENTTEST` | `AllChannelsScan` | `#h3F` | 63 | 63 / 0 | all six |
| `20230829…SINGLE_STEP_` | — | `#h3F` | 63 | 63 / 0 | — |
| `20260720_FirstQualification` | — | `#h3F` | 63 | 63 / 0 | all six |
| `20260726_S183-S185_RVP` | — | `#h3F` | 63 | 63 / 0 | — |

The first row is what pins the low bits down. In the `#h81` run, the `WELLDATA` table's first
channel slot holds real readings (108 wells, 2222–41106 RFU) and **channels 2–6 are exactly zero
in every one of its ten plate reads** — so bit 0 selects channel 1, and bit 7 is not a channel at
all. Every `#h3F` run has all six channels populated.

**For a client.** Preserve the operand as recorded rather than recomputing it; when authoring a
protocol to send, `#h3F` — read everything, step-and-repeat — is the safe default, and is what
CFX Manager itself emits for an authored `.prcl`. `packages/core/src/prcl.ts` keeps the raw value
and does not synthesize one; `parseScanMask()` in `packages/core/src/runDefinition.ts` decodes it,
and is the same function `.Plateread`'s `CHANNELMASK` goes through.

> **Future:** two encodings are unconfirmed because nothing here exercises them. A FRET plate is
> expected to set bit 5 with bit 7 (`#hA0` — channel 6, flyover) by symmetry with fast scan, but
> no FRET run was captured. And no sample selects an *arbitrary* channel subset (say `#h05` for
> channels 1 and 3), so whether firmware accepts one, or only the three named configurations, is
> untested. Don't offer a subset picker on the strength of the bit layout alone.

## 4. Channel 0 and channel 2 — the binary auxiliary streams (partially understood)

Both channels carry a short, fixed-layout binary payload instead of channel 1's command text —
same 5-byte header, `channel=0` or `channel=2`, but the body isn't ASCII. Neither channel's byte
layout is confirmed beyond "it's short and looks fixed-format": the captures don't give enough
variation to pin down what any individual byte means, and nothing here should be read as more
than that.

**Channel 0** is rare (§2's table: 4 messages total, all in `usb-basic`) and is the same exchange
repeated verbatim twice, both times folded into the general identification-query burst right after
enumeration — interleaved with `BASESN?`/`SOFTWARE?`/`ALPHASN?`/`*IDN?`/`CPLD?` (§3), not
lid-specific:

```
OUT  00 05 0a 00 03  02 00 00
IN   00 00 00 00 06  02 00 00 04 0b 00
```

**Channel 2** is the busier of the two — 242 messages in `usb-basic`, 32 in `usb-run` — and, unlike
channel 0, genuinely does cluster around lid activity: this example is the pair immediately
preceding the `LIDFORCE?`/`GETPOS?`/`LIDVERSION?`/`LIDBVERSION?` queries (§3) in `usb-basic`:

```
OUT  02 05 0a 00 05  04 00 00 00 00
IN   02 00 00 00 06  04 00 00 04 64 00
```

A second, longer channel-2 exchange from the same window returns 34 bytes:

```
OUT  02 05 0a 00 07  01 fa 00 10 00 00 20
IN   02 00 00 00 22  01 00 00 00 00 00 01 00 00 00 00 00 00 00 00 00 00 00 07 27 0f 27 0f ee e1
     41 87 a7 30 41 b0 00 00 00
```

**Nothing in either capture exercises the optical head's own scan protocol at all** — see §6.

## 5. File transfer — how a run is actually loaded and read back

This section is the file-transfer *mechanism* — how bytes move in either direction. What a run
does with it, and in what order, is §7.

A run involves both directions: the protocol and plate map are also **uploaded as complete files**,
in exactly the same encrypted-ZIP container this project's `.pltd`/`.prcl` parsers already decode
(see `pltd.md`, `prcl.md`, `zipcrypto.md`), and the results come back down the same way. Note that
the upload is *not* how the instrument is told what to run — the ASCII `PROTOCOL`/`METHOD`/`TEMP`/
`GOTO` directives of §3 are, and they precede the start while the files follow it (§7.3, §7.4).
The uploaded pair is a record deposited in the run folder, which is why §5.1's conclusion — that
the instrument probably never decrypts either file — is consistent with a run working at all.

**Upload**, one command per file, no separate chunking protocol observed (small files went in one
message; see §2's note on message-vs-USB-packet size):

```
CRCSENDFILE "<crc>*<device path>",<raw file bytes>
```

`<crc>` is the client's own checksum of the file it's about to send — not a session ID or ticket
number, and not a length field. Despite the command name it is **not a CRC**: it is a
byte-interleaved XOR (XOR the even-indexed bytes into a high byte, the odd-indexed into a low one,
combine as `(even << 8) | odd`), written as **5 zero-padded decimal digits**. That formula
reproduces all four uploads in the capture exactly; §7.4 has it written out and notes what it does
and doesn't catch. The round trip is confirmed end-to-end, not guessed: for every one of the four
files, the value the device reports back after the upload (via `COMPUTEFILECRC`/`GETFILECRC`,
below) matches the `<crc>` sent up front, exactly:

| File | `<crc>` sent | Upload size | GUID `COMPUTEFILECRC` returned | `GETFILECRC` on that GUID |
|---|---|---|---|---|
| `GlobData.xml` | 24700 | 17,299 bytes (XML) | `fad4f43f-e127-4b35-857d-1aba9bd5a615` | `24700;0000` |
| `QuickPlate_96 wells_All Channels.pltd` | 05672 | 1,821 bytes (zip) | `0e72e6e2-5b85-4d00-b08a-41db67adaaa8` | `5672;0000` |
| `RunInfo.xml` | 49503 | 8,751 bytes (XML) | `e6328d75-08d1-406d-914f-88ea6dfa16df` | `49503;0000` |
| `singletest.prcl` | 46850 | 1,291 bytes (zip) | `988ed34b-647d-48be-ab4c-db6b1b3af9f0` | `46850;0000` |

That resolves what was previously two separate open questions about this sequence into one
mechanism. The full per-file sequence observed:

1. `DELFILE <friendly path>` — clear any stale file at the well-known name. Answers `0000` if one
   was there, the `05 00 09 00` `passThrough` payload below if not; both are fine.
2. `CRCSENDFILE "<crc>*<friendly path>",<bytes>` — upload, `<crc>` computed by the client beforehand.
3. `COMPUTEFILECRC "<friendly path>"` — **despite the name, this doesn't return a CRC.** The
   device stores the just-uploaded file under a generated GUID name rather than the friendly one,
   and this is the call that hands that GUID name back: the response is `<dir>\<GUID>;0000`. The
   GUID entry is short-lived (§7.4) — use it for step 5 and don't keep it.
4. `GETFILESLEN`/`LISTALLFILES <dir>` — the host re-lists the directory. The GUID name is already
   in hand from step 3 by this point, so the *purpose* here looks like a UI refresh — but the
   pairing itself is mandatory, not incidental. See "Listing a directory" below.
5. `GETFILECRC "<dir>\<GUID>"` — the device's own CRC of the GUID-stored file, which the client can
   now compare against the `<crc>` it sent in step 2 to confirm the upload landed intact (table
   above).

The observed upload order across a run's four files: `GlobData.xml`, the `.pltd` plate map,
`RunInfo.xml`, the `.prcl` protocol — all four *after* the run has already started (§7.4).

Nothing here uploads a file large enough to need splitting (the largest is 17 KB, and §2 records
that a whole file went out as one logical message). Whether there is a ceiling, and what a client
should do at it, is untested.

### 5.1 There is no protocol library on the instrument, and probably no decryption either

Two things a client wanting to start a run will look for, and not find.

**No stored-protocol library to name.** The live filesystem probe below found `\Storage Card`
holds nothing but `CurrentRun` and `PCRunReport`, directories never appear in listings, and no
command in either capture selects a protocol by name — `RemoteRun` takes a run name, user and
method, not a path. So "run a protocol the instrument already has" is not a thing the protocol
expresses: a run's protocol is whatever the host most recently put in `CurrentRun`. The one
untested variant is `RemoteRun` with no upload at all, re-running whatever `CurrentRun` still
holds.

**The instrument probably never decrypts a `.prcl`/`.pltd`.** Not established, but the evidence
points one way. Of the five committed `.zpcr` samples — all written by the instrument itself —
every one carries a plaintext `ProtocolRunDefinition.txt`, exactly one carries a `.prcl` at all,
and none carries a `.pltd` the instrument produced. Encryption (`zipcrypto.md`) arrived in CFX
Manager, and the firmware looks to have been left alone; the encrypted pair in the upload set
reads as the PC software round-tripping its own config files through a run's results, so that
CFX Manager can reopen the run with its plate map intact. If that's right, the plaintext
directive list of `prcl.md` §3 is what actually matters to the instrument, and the ASCII step
list CFX Manager sends in parallel (below) is not redundant at all. Confirming it takes one
experiment on live hardware: author a run over the ASCII channel only, upload nothing, and see
whether it cycles.

**Listing a directory** is a two-command operation that has to stay together (measured live):

```
GETFILESLEN <dir>            → "<byte length of the listing>;0000"   ← computes AND buffers it
LISTALLFILES <dir>           → the buffered listing, comma-separated
```

`LISTALLFILES` returns whatever the **last** `GETFILESLEN` buffered and **ignores its own path
argument entirely**. Issuing `GETFILESLEN \Storage Card\CurrentRun` and then
`LISTALLFILES \Storage Card\PCRunReport` returns CurrentRun's 42 entries; issuing
`LISTALLFILES` with no `GETFILESLEN` before it returns whatever was buffered last — a value that
survives closing the USB connection and reopening it, since the state lives on the instrument.
Two consequences for a client:

- The pair must be **atomic**. Two directory listings running concurrently will each report the
  other's contents. This is why `CfxDevice.listFiles` holds the command channel across both.
- When `GETFILESLEN` does *not* return a length it answers with a `passThrough` binary payload
  (§2) instead, and the correct move is to not send `LISTALLFILES` — with nothing newly buffered,
  anything it returned would be another directory's contents under this path's name. Measured
  live: after `GETFILESLEN \Storage Card\CurrentRun`, a failing `GETFILESLEN \Storage Card`
  leaves the buffer intact, so `LISTALLFILES \Storage Card` still hands back CurrentRun's full
  881-character listing.

**The binary payload is a status code, and there are two of them** (measured live — one probe over
a dozen paths):

| Payload | Meaning | Paths that produced it |
|---|---|---|
| `07 00 09 00` | **Directory exists, but holds no files.** Listings cover files only, so a directory containing nothing but subdirectories reports this. | `\Storage Card`, `\Temp`, `\My Documents` |
| `04 00 09 00` | **No such directory** — including a path that names a *file*, and a `GETFILESLEN` with no argument at all. | `\Nonexistent`, `\Storage Card\NoSuchDir`, `\Storage Card\CurrentRun\runlog.xml`, `\Application Data` |
| `05 00 09 00` | **No such file** — the same family, seen from `DELFILE` rather than `GETFILESLEN`: deleting a file that isn't there answers with this instead of `0000` (§7.4). Not an error; a client clearing a destination before an upload should accept it. | three of the four `DELFILE`s that precede a run's uploads |

So `\Storage Card` is not a special case in the protocol, and the volume root is not what matters:
`\` itself lists fine (`17;0000` → `Control Panel.lnk`), as does `\Windows` (`4632`).
`\Storage Card` simply contains nothing but `CurrentRun` and `PCRunReport`, and directories never
appear in a listing. Path spelling makes no difference — quoted, unquoted, trailing `\`, forward
slashes and lowercase all give the identical reply, and a `*` glob is taken as a literal name and
comes back "not found". Whether the four bytes are two little-endian `uint16`s or something else
isn't established; a client should compare them whole. Anything *other* than these two should be
treated like "not found": nothing was learned, so nothing can be listed.

This also explains a detail of the capture that previously read as redundancy: CFX Manager always
issues the two together, in that order, because it has to.

**Download** is simpler and has no GUID indirection:

```
GETFILESIZE <path>          → "<byte count>;0000"
GETFILE <path>               → raw file bytes, length == the announced GETFILESIZE, as one
                                logical message chunked per §2 (4096-byte reads observed)
```

`GETFILE`'s reply is the file and nothing else — no trailing `;0000` — so it is the one response
that must not go through the §3 value/code parser, which would read the last `;` in a binary file
as a field separator. Confirmed live: `Read00001.Plateread` came back as exactly the 22,037 bytes
`GETFILESIZE` announced, and decoded with this repo's existing `plateread.md` parser unchanged.

Both plate reads in the `usb-run` capture were pulled this way — `Read00001.Plateread` (22,037
bytes) partway through the run, `Read00002.Plateread` after the second cycle, then the run
report (`<timestamp>_<serial>_<run name>.alf`) from `\Storage Card\PCRunReport\` once the run had
finished. `Read0000N.Plateread` is exactly the `.Plateread` format `plateread.md` documents — no
new decoding needed there, this just confirms *where* and *when* those bytes come off the wire.
`.alf` (the run-report archive CFX Manager itself opens back up as a `.pcrd`-shaped view) wasn't
opened further here.

## 6. What's still a real gap

The captures used here never triggered the optical head's own scan command surface. Both plate
reads in `usb-run` came from firmware executing a `PLATEREAD` step already baked into the authored
protocol (§7.2), autonomously, with the result simply pulled off afterward as a file — the host never had
to speak to the optical head directly. **This means a WebUSB client that only needs to run an
existing protocol and collect its plate reads does not need to reverse the optical protocol at
all** — §2 through §5 are sufficient for that. Only a client that wants to trigger a scan *outside*
of a running protocol (e.g. a manual single-read, or calibration) would need §4 characterized
further, or a capture that actually exercises that path.

## 7. Performing a run

§3 and §5 give the vocabulary; this section is the **order the pieces go in**, start to finish,
reconstructed command-by-command from `usb-run` — the one capture in which a complete run happens.
It describes what a client has to do, not what CFX Manager's UI happens to do around it: the
timings and the one operator intervention are that instrument and that operator, the sequence is
the protocol.

Six phases, and the shape is not what §5's upload machinery suggests:

| Phase | What happens | §  |
|---|---|---|
| 1. Pre-flight | a burst of readiness queries; clear the old run report | 7.1 |
| 2. Author | the protocol typed in as ASCII directives, one per command | 7.2 |
| 3. Start | `RemoteRun` — **the run begins here**, on this command | 7.3 |
| 4. Deposit | the four host-side files copied into the run folder, *after* the start | 7.4 |
| 5. Watch | poll `STATUS?`; pull each `Read0000N.Plateread` as its step completes | 7.5 |
| 6. Finish | acknowledge the finished run with `CANCEL`; pull the last read and the report | 7.6 |

Throughout all six, the §3 polling loop — `STATUS?`, `ERRORLIST A`, `RTSTATUS?`, about once a
second — never stops. Everything below is interleaved into it, not substituted for it.

**The headline correction.** Reading §5 alone, the obvious model is "upload the protocol, then tell
the instrument to run it". That is not what happens. The protocol is **typed in as ASCII
directives** (§7.2) and `RemoteRun` starts *that*; the `.prcl`/`.pltd` upload begins **13 seconds
after `RemoteRun`, with the run already under way** and cannot be what the instrument executes.
§5.1 argued from
the sample archives that the instrument probably never decrypts a `.prcl`; the ordering here is the
direct wire evidence for the same conclusion. The files are a **deposit**, not an instruction —
see §7.4.

### 7.1 Pre-flight

A burst of queries that appears nowhere else in `usb-run` — each of them exactly here, and four of
them once more after the run ends, which is what marks the burst as run setup rather than either
the ordinary polling of §3 or the connection-time identification burst §3 describes:

```
WORKING?  BOOTMODE?  BLOCKCOUNT?  VOLUME?  ALPHAID?  BLOCKCOUNT?
ERRORS?   SELFTEST?  ENABLERT?    ALPHAID?           SUPERLOCKDOWNMODE?
```

The repeats are as observed — the burst is not deduplicated. Read as a readiness check it is
coherent: the front end is alive (`WORKING?`) and not in bootloader (`BOOTMODE?`), the block is
the one expected (`ALPHAID?`, `BLOCKCOUNT?`), nothing is faulted (`ERRORS?`, `SELFTEST?`), and the
instrument isn't locked against remote control (`SUPERLOCKDOWNMODE?` → `OFF`). A client can send as
much or as little of this as it wants; none of it changes instrument state.

Then the **run-report directory is cleared** — the previous run's report is deleted before the new
run creates one:

```
GETFILESLEN  \Storage Card\PCRunReport   → 41;0000
LISTALLFILES \Storage Card\PCRunReport   → 20260725_124811_CT019138_GRADIENTTEST.alf;0000
DELFILE      \Storage Card\PCRunReport\20260725_124811_CT019138_GRADIENTTEST.alf   → 0000
```

This is worth copying rather than skipping: `\Storage Card\PCRunReport` then holds exactly one
`.alf`, so in §7.6 the new report is identifiable without matching names or timestamps.

### 7.2 Authoring the protocol

Each directive of the protocol language is its own command frame, each acknowledged with a bare
`0000`. **`protocol.md` §7 is the authority for this half** — the grammar, the operand meanings,
and why the wire form has no `;` separator. In brief, and in the order sent:

```
PROTOCOL 'PCRUN'          METHOD CALC   HOTLID 105,30   VOLUME 25
TEMP 95.0,180   TEMP 95.0,10   TEMP 55.0,30   PLATEREAD #h3F   GOTO 2,1   END
```

Two things about `PROTOCOL`'s operand. It is **not the run's name** — the name travels in
`RemoteRun` (§7.3), and the run this capture performed is called `singletest` everywhere it
matters (`STATUS?`, the `.alf`) while `PROTOCOL` says `PCRUN`. And it is not a *lookup*: §5.1
establishes there is no stored-protocol library to select from, so this names the protocol being
authored right now, into the one slot the instrument has. `PCRUN` reads as a fixed placeholder for
a PC-driven run, and a client has no reason to send anything else.

`PLATEREAD`'s operand is the scan mask of §3.1 — take it from the plate, not from the authored
protocol.

### 7.3 Starting — `RemoteRun`

```
RemoteRun "A","True","False","singletest","admin","","True","CALC"   → 0000
```

Eight positional operands: `<block>,<lid on>,<remote start>,<run name>,<user>,<sample ID>,<sierra
mode>,<method>` (§9 records which four are corroborated and which three are named from the language
rather than demonstrated).

**The run starts on this command, with nothing further required.** Measured: `RemoteRun` returned
`0000`, and 11 s later `STATUS?` left `IDLE` for
`…;1;1;TEMP 95.0,180;1;"SINGLETE",CALC,ON;…` — cycle 1, step 1, the authored run name, the lid
`ON`. No confirmation, no second command. With `<remote start>` = `"False"`, "wait for someone to
press start at the instrument" is evidently what the client is *declining*.

What follows the start is the lid: for the next ~180 s the lid temperature climbs 19 → 95 °C while
the block sits at ambient 17 °C, and only then does the block ramp. A client that expects to see
block temperature move immediately will think the run has hung. `STATUS?`'s step-remaining field
does not tick during this phase either.

Two more commands appear here, both optional: `VOLUME?` (reading back the `VOLUME 25` just set —
a verification, and note the instrument reverts to its own value once the run ends) and
`ADDCYCLES 0`, a no-op form of the command that extends a running loop.

### 7.4 Depositing the run's files

**Thirteen seconds after the run is already under way**, four files are copied into
`\Storage Card\CurrentRun\`, in this order:

| # | File | Size | What it is |
|---|---|---|---|
| 1 | `GlobData.xml` | 17,299 | the *host's* inventory — machine name, user, and a 114-entry list of the PC software's own files and versions |
| 2 | `QuickPlate_96 wells_All Channels.pltd` | 1,821 | the plate map, as the encrypted ZIP of `pltd.md` |
| 3 | `RunInfo.xml` | 8,751 | run metadata, including the `ScanMask` echo of §3.1 |
| 4 | `singletest.prcl` | 1,291 | the protocol, as the encrypted ZIP of `prcl.md` |

Each one goes through the same five-command cycle of §5 — `DELFILE`, `CRCSENDFILE`,
`COMPUTEFILECRC`, `GETFILESLEN`+`LISTALLFILES`, `GETFILECRC` — with the returned checksum matching
the one sent, all four times.

**What this is for.** It cannot be the instruction to run: `STATUS?` had been reporting the run's
first step for 13 s by the time the first byte of it went out. What it does do is make the run
folder self-contained. The instrument writes its *own* record of the
protocol as the plaintext `ProtocolRunDefinition.txt`, transcribed from the §7.2 directives; the
`.prcl`/`.pltd` pair deposited here is the host's richer version — plate map, well contents, dye
assignments, none of which the directive list can express — so that when the whole directory is
later zipped into a `.zpcr` (§7.6), the archive reopens with everything the PC knew about the run.
`GlobData.xml` is provenance in the same spirit. **A client that only wants to run a protocol and
read the fluorescence can skip this phase entirely**; a client that wants the run to open later as
a complete experiment should not.

**The upload checksum is not a CRC** — it is a byte-interleaved XOR, and it reproduces all four
uploads exactly:

```
even = 0; odd = 0
for i, b in file:  (i even ? even : odd) ^= b
checksum = (even << 8) | odd          → formatted as 5 zero-padded decimal digits
```

`GlobData.xml` → `24700`, the `.pltd` → `05672`, `RunInfo.xml` → `49503`, the `.prcl` → `46850`,
each matching both the value sent in `CRCSENDFILE` and the value `GETFILECRC` returns for the
stored file. It is a weak check — any two bytes swapped an even distance apart is invisible to it —
but it is the one the instrument agrees with, and the zero-padded 5-digit format is fixed (`05672`,
not `5672`), so a client must format it that way going out even though `GETFILECRC` answers back
unpadded.

Three details of the cycle that only this sequence shows:

- **`DELFILE` on a file that isn't there** answers with a `passThrough` binary payload (§2) of
  `05 00 09 00` — a third member of §5's status-code family, "no such file", alongside
  `07 00 09 00` (empty directory) and `04 00 09 00` (no such directory). Three of the four
  `DELFILE`s got it, and the fourth — `RunInfo.xml`, left over from the previous run — got a plain
  `0000`. Neither is an error; a client should accept both and continue.
- **The GUID is transient.** `COMPUTEFILECRC` hands back `<dir>\<GUID>` (§5), and the listing taken
  immediately after contains that GUID *and* the friendly name; by the next file's listing the GUID
  is gone and only the friendly name remains. So the GUID is a staging copy with a short life —
  use it for the `GETFILECRC` that follows and don't retain it.
- **The listing in the middle of the cycle is a UI refresh**, not a protocol requirement — the GUID
  is already known from `COMPUTEFILECRC`. The `GETFILESLEN`+`LISTALLFILES` *pairing* is mandatory
  (§5); this particular pair of listings is not.

### 7.5 Watching the run, and pulling plate reads

`STATUS?` is the whole mechanism. Its current-step field carries the step's command text verbatim,
so while a plate read executes it reads `PLATEREAD #h3F` (§3.1's live echo), and **the completed
`.Plateread` file appears when that step ends**. The host does not poll the filesystem waiting for
it — it watches `STATUS?` for the step to change, and reacts:

```
STATUS? → …;1;1;PLATEREAD #h3F;4;"SINGLETE",CALC,ON;…      the read is running
STATUS? → …;2;2;TEMP 95.0,10;2;"SINGLETE",CALC,ON;…        step moved on, cycle 2
GETFILESLEN  \Storage Card\CurrentRun          → 798;0000    ← 200 ms later
LISTALLFILES \Storage Card\CurrentRun          → …,Read00001.Plateread;0000
GETFILESIZE  \Storage Card\CurrentRun\Read00001.Plateread   → 22037;0000
GETFILE      \Storage Card\CurrentRun\Read00001.Plateread   → 22,037 raw bytes
```

Reads are numbered `Read00001.Plateread`, `Read00002.Plateread`, … in execution order and are
exactly the format `plateread.md` documents. `GETFILE`'s reply is raw bytes with no `;0000` — see
§5's warning about not putting it through the response parser.

**The last read of a run needs separate handling.** When the final `PLATEREAD` is also the last
step, the transition this whole mechanism watches for is `PLATEREAD` → `IDLE`, not `PLATEREAD` →
another step, and in the capture no listing was attempted at that moment at all: the second read
was picked up after the run was acknowledged (§7.6), 66 s later. Whether it would have been
listable earlier is untested — so a client should re-list once at the end rather than assume the
step-transition rule caught everything.

The run folder also accumulates **marker files** the instrument writes as it goes:
`calibrationfilescopied` and `begun` are already there by the first listing after the start,
`lastplatereadstatus` appears alongside the first plate read, and `ended` plus `ProtocolName.txt`
at the finish. They are a coarse second source of run state, and `ended` is the filesystem-visible
answer to "is it done"; `STATUS?` is the faster one.

**`PROCEED` is "skip to the next step", not "resume" or "confirm".** This corrects what §3's table
guessed from a two-minute gap in the capture. Measured: `PROCEED` went out 215 s after `RemoteRun`,
while `STATUS?` was reporting step 1 — `TEMP 95.0,180`, a 3-minute hold the block had only reached
95 °C for 9 s earlier, so it cannot have run out — and the very next poll, 1.1 s later, reported
step 2. It did not start the run (§7.3 shows the run started at `RemoteRun`) and there was nothing
paused to resume. The operator was cutting the initial denaturation short.

### 7.6 Finishing

When the protocol completes, `STATUS?` reports a state that is neither running nor truly idle:

```
…;0;0;IDLE;0;"SINGLETE",CALC,OFF;32;192.13;…      finished, still holding the run
…;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;…                 idle — after CANCEL
```

The step is `IDLE` and the cycle counters are 0, but the **run name is still attached** and the
method still reads `CALC` — the instrument is holding the finished run. `CANCEL` clears it to the
empty-name `"",BLOCK,OFF` idle of §3. So `CANCEL` here is an acknowledgement, not an abort; §3
inferred that from the listing, and this state transition is the direct evidence. Sequence:

```
CANCEL                                          → 0000
ERRORS?                                         → 0;0000    (twice, a few seconds apart)
GETFILESLEN + LISTALLFILES \Storage Card\CurrentRun    → now with `ended`, Read00002, ProtocolName.txt, and the .alf
GETFILESIZE + GETFILE      …\Read00002.Plateread       → the final read
GETFILESLEN + LISTALLFILES \Storage Card\PCRunReport   → 20260731_213926_CT019138_SINGLETEST.alf
GETFILESIZE + GETFILE      …\<that file>               → the run report
```

The report's name is `<yyyymmdd>_<hhmmss>_<serial>_<RUN NAME>.alf`, and because §7.1 emptied the
directory it is the only entry. It is small (693 bytes here) and its first line is a `*`-separated
summary — run name, user, block serials, model, start/end/elapsed times, lid temperature, volume.
The same `.alf` is also copied into `\Storage Card\CurrentRun`, so a client taking the whole folder
gets it either way.

Finally, `FRONTENDLOCKED OFF` releases the instrument's touchscreen, which was locked for the
duration of the PC-driven session (`ON` appears in `usb-basic`, at the other end of the same
mechanism). A client that locks the front end must release it; one that never locked it has nothing
to undo.

### 7.7 Minimal client sequence

Putting §1–§5 and the above together — the shape of a client that runs a protocol and collects its
plate reads:

1. `navigator.usb.requestDevice({ filters: [{ vendorId: 0x0614 }] })`, `open()`,
   `selectConfiguration(1)`, `claimInterface(0)`.
2. Send `*IDN?` (§3) over endpoint 2 OUT, read the response on endpoint 6 IN, to confirm framing
   and identify the unit. Read the IN endpoint with **one loop that reassembles and demultiplexes
   by channel**, not a read-per-command: channel 2 carries unsolicited traffic (§2, §4), so a
   per-command reader eventually returns a channel-2 payload as the answer to a channel-1 query
   and every reply after it is off by one.
3. Start the polling loop — `STATUS?`/`RTSTATUS?`/`ERRORLIST A` (§3), ~1 Hz — and keep it running
   for everything below. It is both the liveness check and, from §7.5, the run's only real progress
   signal.
4. Pre-flight (§7.1): confirm `SUPERLOCKDOWNMODE?` is `OFF` and `ERRORS?` is `0`; clear
   `\Storage Card\PCRunReport` of the previous `.alf`.
5. Author the protocol (§7.2, `protocol.md` §7): `PROTOCOL 'PCRUN'`, the `METHOD`/`HOTLID`/`VOLUME`
   header, one command per step, `END`. Check every `0000`; a bad step fails at that step.
6. `RemoteRun "A","True","False","<name>","<user>","","True","<method>"` (§7.3) — **this starts
   it.** Expect `STATUS?` to leave `IDLE` within ~10 s, and expect the lid, not the block, to heat
   first.
7. Optionally deposit `GlobData.xml`/`.pltd`/`RunInfo.xml`/`.prcl` into
   `\Storage Card\CurrentRun\` (§7.4) if the finished run should be a complete experiment rather
   than just fluorescence. Skip it otherwise.
8. Watch `STATUS?` (§7.5). Each time the current step leaves a `PLATEREAD`, list the run directory
   with the mandatory `GETFILESLEN`+`LISTALLFILES` pair (§5, keep the two adjacent) and pull the
   new `Read0000N.Plateread` with `GETFILESIZE`+`GETFILE`. Decode with the existing
   `plateread.md`/`packages/core` parser.
9. On `IDLE`-with-a-run-name (§7.6): `CANCEL`, re-list — the final read appears only now — pull it,
   then pull the `.alf` from `\Storage Card\PCRunReport\` if wanted.
10. To take the *whole* run rather than its pieces: pull every file `LISTALLFILES` reported for
    `\Storage Card\CurrentRun` and zip them unchanged — a `.zpcr` is a plain ZIP of exactly that
    directory, so no conversion is involved. `zpcrFromRunFiles` (`packages/core/src/runFolder.ts`)
    does this, and is what the web app's Instrument view "Open run" button calls.

## 8. Tooling

`tools/usbpcap_decode.py` decodes a USBPcap-format `.pcapng` capture: the outer USBPcap capture
envelope (a public, documented format — see desowin.org/usbpcap/captureformat.html — distinct
from this document's own §2 application header) plus the CFX96 5-byte header and channel-1 ASCII
payloads. It needs `pip install dpkt` for pcapng framing only; the USBPcap and CFX96 header
parsing is hand-rolled (`dpkt` doesn't know either format). Usage:

```sh
python3 tools/usbpcap_decode.py capture.pcapng                  # list devices + VID:PID seen
python3 tools/usbpcap_decode.py capture.pcapng --device 3        # decode channel-1 traffic for device #3
python3 tools/usbpcap_decode.py capture.pcapng --device 3 --raw  # + channel 0/2, control transfers
```

`dump_device()` reassembles each direction's bulk stream into complete logical messages —
tracking how many payload bytes are still owed to the in-progress message, per direction — before
trying to parse a 5-byte header out of anything. An earlier version parsed every packet
independently instead, which worked for the ASCII channel-1 traffic that makes up the bulk of both
captures, but occasionally misread raw continuation bytes of a large transfer (e.g. mid-`GETFILE`
of a multi-hundred-KB `.zpcr` file) as a fresh header when those bytes happened to look like one —
fabricating short spurious messages on channels that were never really used. §2's channel counts
and §4's examples were produced with the reassembling version and are the basis for saying channel
3 never really appears in either capture.

## 9. Appendix: single-observation caveats

Claims elsewhere in this document that rest on one instrument, one capture pair, or one observed
instance, rather than a cross-checked pattern:

- **Other Bio-Rad PIDs** (§1) — the C1000 non-touch, CFX Connect, and S1000 likely share idVendor
  `0x0614` with their own idProduct, but none were captured; a factory-fresh unit presenting
  Cypress's own `0x0547:0x0080`/`0x0547:0x2131` (the bridge-chip vendor) wasn't captured either.
- **`handle` is always 0** (§2) — true for all 4,657 reassembled messages across both captures,
  from one instrument talking to one CFX Manager install. Whether a second logical session (a
  nonzero handle) is ever opened is unconfirmed.
- **`ALPHAID?` → `4`** (§3) — one instrument, one observed value; the general ID→name mapping for
  other block/head types isn't in this capture.
- **`GETPOS?`, `TESTMODE`, `SETAPILOGLEVEL`** (§3) — recorded with their literal observed
  values; the capture doesn't say more about what any of them mean than the command name itself
  suggests. (`BLOCKID` was in this list until the operator's own account of `usb-basic` — flash,
  open, close — identified it; see §3.)
- **Channel 0 and channel 2's byte layout** (§4) — both channels' examples are real and
  byte-exact, but with this little variation in the traffic, no individual byte's meaning is
  confirmed for either.
- **`RemoteRun`'s operand names** (§3) — the capture corroborates four of the eight positionally:
  `"A"` is the block letter `ERRORLIST A` also uses, `"singletest"` is the run name the resulting
  `.alf` report carries, `"admin"` the operator, `"CALC"` the method already sent as `METHOD`. The
  three booleans between them are named from the language rather than demonstrated — nothing in
  either capture varies them.
- **The run sequence** (§7) — one run, one operator, one instrument. The *ordering* claims are
  strong (they are what the wire did, and the run-starts-at-`RemoteRun` and `PROCEED`-skips-a-step
  findings each rest on a `STATUS?` transition, not on inference), but nothing here varies the
  protocol, the plate, `RemoteRun`'s booleans, or the failure paths. In particular: no run was
  aborted mid-flight, no step failed authoring, and no error code other than `0000` was ever seen,
  so what a client should do when something goes wrong is not documented because it was never
  observed. The pre-flight burst of §7.1 is likewise "what this client sends", not a demonstrated
  requirement — none of it changes instrument state.
- **`PLATEREAD #h<hex>`'s per-channel bits** (§3.1) — the mask's two *fields* are cross-checked
  (five runs, two configurations, three independent echoes of the value), and **bit 0 = channel 1**
  is measured directly from the one `#h81` run's all-zero channels 2–6. Bits 1–5 mapping to
  channels 2–6 in order follows by extension: no sample sets any of them individually, so nothing
  here would distinguish that ordering from another. Nor does anything here exercise bit 6,
  FRET, or a mask that is neither `#h3F` nor `#h81`.

## 10. Implementation

`packages/core/src/usb/` implements §1–§5 as an isomorphic client, entry point `CfxDevice`:

| File | Covers |
|---|---|
| `frame.ts` | §2 — the 5-byte header codec, and `FrameReassembler`, which turns a direction's byte stream into complete logical messages. The only supported way to read this protocol; see §8 for the bug that parsing per packet causes. |
| `commands.ts` | §3 — command encoding and the two response shapes, plus `CFX_COMMANDS`, the action commands a UI might offer, each tagged with whether it was actually observed, and `assertCommandArgument`, which keeps a path from injecting a second command line. |
| `status.ts` | §3 — typed views over `*IDN?`, `STATUS?` and `RTSTATUS?`. Names only the fields whose meaning is established, and keeps the raw field array beside them for the rest. |
| `transport.ts` | §1 — the endpoint/interface constants and `UsbDeviceLike`, the structural interface both environments satisfy. |
| `device.ts` | §3–§5 — the read pump, the command queue, and the typed operations. |

**One implementation serves both a browser and Node.** node-usb ships a WebUSB implementation, so
a browser `USBDevice` and node-usb's satisfy the same structural interface and the environments
differ only in how the device handle is obtained — `navigator.usb` versus `new WebUSB(…)`. Nothing
above that line is environment-specific. `transport.ts`'s module comment carries the full
rationale.

Two clients drive it: `tools/cfx.mjs` (a CLI — `info`, `status`, `ls`, `get`, plus `--trace` for
the raw message log) and the web app's **Device** view, which adds live status polling, a file
browser, action buttons and a console of decoded traffic. The optional `usb` dependency is needed
only by the CLI.

**The client sends only command lines it builds itself.** `CfxDevice`'s public surface is named
operations — `status()`, `listFiles(dir)`, `getFile(path)`, `runAction(name)` — and the primitives
that take a command line (`send`/`command`/`tryCommand`/`sequence`) are private. There is no
"send this string" call, and correspondingly no command prompt in the Instrument view and no `cmd`
subcommand in the CLI; both had one, and both lost it deliberately. The reasoning is the same in
each place: the vocabulary in §3 is what two captures happened to contain rather than a
specification, a mistyped line is indistinguishable on the wire from an intended one, and the
instrument on the other end heats a block and moves a lid. Reaching a command this library doesn't
implement means adding a method — which is also where its reply becomes typed and its provenance
gets recorded here.

The one caller-supplied text that still reaches a command line is a filesystem path, which the
`GETFILE`/`GETFILESIZE`/`LISTALLFILES`/`DELFILE` operations interpolate. `assertCommandArgument`
in `commands.ts` rejects any byte outside printable ASCII before that happens — a path carrying a
CR or LF would otherwise terminate the line early and frame the rest as a second, caller-chosen
command, reintroducing the arbitrary-command channel through the back door.

`CFX_COMMANDS` in `commands.ts` is the action-command catalog a UI can offer, and now also the
complete set of things a client can make the instrument do — currently `BLOCKID 1` (flash the
indicator), `LID OPEN`, `LID CLOSE` and `CANCEL` — each tagged with how it is known to do what it
says. All four are `observed`; the tag exists so that a future addition that *isn't* has somewhere
to say so, and so a UI can mark it rather than presenting a guess as a feature.

Not implemented: file **upload** (`CRCSENDFILE` and the §5 GUID sequence), run control
(`RemoteRun`/`PROCEED`), and protocol authoring — this client reads an instrument and retrieves
files from it; it does not start runs. §6's gap is unchanged and unaffected.

The Instrument view nonetheless **stages a run**, which is everything on the host side of starting one
and nothing on the wire: pick the protocol and the plate from the app's loaded files — a whole run
supplies both, a `.prcl.txt` (`prcl.md` §3.1) or a `.pltd`/`.plt.csv` overrides either half —
review the exact directives that would be sent alongside the plate they'd run on, and stop there.
Its **Start run** button is disabled, and will stay disabled until the commands above exist: a
button that looks live and does nothing is worse than one that says what it is waiting for, and
this is the one part of the app that would heat a block. The app side is documented in
`apps/web/ARCHITECTURE.md`, "The Instrument view".
