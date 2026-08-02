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

A third source has since been added: **`usb-cancel`**, this project's own traffic log of a run it
started and then aborted from the host (a `.zpcr`'s `usb-traffic.log` entry, written by the web
app's Instrument view rather than by USBPcap, so it is decoded messages rather than raw packets).
It is the only capture of a run that did not complete, and §7.8 is measured from it — including
one correction to what that section previously asserted.

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
already running), and `PROCEED` is "skip a step", not "start". `CANCEL` is both the abort and the
acknowledgement of a finished run, and getting a running run stopped takes one of each — §7.8.

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
| `STATUS?` | idle: `17.04;18.3;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;17.04;CLOSED;0;0000` — mid-run: `60.25;104.9;2;2;TEMP 95.0,10;2;"SINGLETE",CALC,ON;96;110.22;0.00;75.15;2.10;0.00;0;0;6;55.61;CLOSED;0;0000` | block temp, lid temp, two counters that both track the **cycle**, the current step text, that step's **1-based protocol step number**, run descriptor, a run state code, then the timers — both examples are the complete response, not truncated. **§3.2 maps all twenty fields**, including the run's elapsed time and its time remaining. The step number is the field *after* the step text — `PLATEREAD #h3F` reports `4` in a protocol where the plate read is the fourth step, which is one of the two measurements behind `protocol.md` §4. The two counters *before* the step text are not separable from each other in this capture (`protocol.md` §9) |
| `RTSTATUS?` | `18.31;26;;0000` | shorter status, polled alongside `STATUS?` |
| `ERRORLIST A` | `;0000` | polled every cycle in lockstep with `STATUS?`/`RTSTATUS?` |

Both status replies are decoded field by field below: **§3.2** for `STATUS?` and **§3.3** for
`RTSTATUS?`, which is the optical head's — shuttle temperature, ambient temperature, and a fault
list that is empty when healthy.

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
| `RemoteRun "<block>","<lid on>","<remote start>","<name>","<user>","<sample ID>","<sierra mode>","<method>"` | e.g. `RemoteRun "A","True","False","singletest","admin","","True","CALC"` — starts the authored protocol, carrying what the protocol text cannot (`protocol.md` §7). **§7.3 defines all eight operands** — notably `<remote start>` (start from the instrument's own touchscreen instead of now) and `<sierra mode>` (the instrument runs the protocol *and* its own optics autonomously, which is why §6's optical protocol never has to be spoken) |
| `PROCEED` | **skips to the next step** of a running protocol. Not a start or a resume: it was sent 215 s into a run, while a 3-minute hold still had time left, and the very next `STATUS?` was on the following step — §7.5 |
| `CANCEL` | **ends a run — finished or in progress.** On a finished run it is the acknowledgement: it clears the run name the instrument keeps holding after the protocol ends, and the run's final `Read0000N.Plateread` is picked up after it (§7.6 has the `STATUS?` transition). It is also the only abort in the language — **§7.8 is how to stop a run in progress cleanly**, now measured against a live abort, and note that stopping a running run takes *two* of these (the abort, then the acknowledgement) |
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

**Two more configurations the language defines, neither exercised here.** The mask is not limited
to the two values above: a **FRET** scan is `#hA0` — bit 5 with bit 7, i.e. channel 6 read in
flyover, the exact symmetry with fast scan this section previously only guessed at — and a
**two-colour** scan is `#h03`, channels 1 and 2, step-and-repeat. The second matters because it
answers the standing question about subsets: a mask that is not one of the named configurations is
at least *expressible*, so the byte really is a channel selection and not an enum in disguise.

> **Still unconfirmed:** no sample or capture here contains either value, so nothing measures what
> the instrument does with them; and nothing exercises an arbitrary subset (say `#h05`, channels 1
> and 3) that no named configuration corresponds to. Bit 6 remains unused and unexplained. A client
> should still preserve a recorded mask rather than synthesize one, and should not offer a
> free-form channel picker on the strength of the bit layout alone.

### 3.2 `STATUS?`'s twenty fields — and the run's time remaining

`STATUS?` is the busiest reply in the protocol, and the table above only names the fields the early
passes happened to need. Every field now has an established meaning. They are checked here against
both captures — 507 replies spanning a complete two-cycle run in `usb-run`, 159 idle replies in
`usb-basic`, 666 in total — and the column on the right of the table says which ones that traffic
actually exercises, because a name is not a measurement. The headline for a client: one of these
fields is a **live countdown of the time left in the run**, and another is a flag word that answers
"is the block at temperature" without any temperature arithmetic.

**The reply is 19 status fields plus a trailing result code**, and the 19 are a fixed record. On an
instrument with more than one independent block the record **repeats, once per block, before the
single trailing code** — a two-block reply is 39 semicolon-separated parts, with block 2's fields
at index 19 + *n*. A CFX96 has one block, so its reply is always 20 parts, but a parser should key
off the record length rather than assume it.

| # | Field | Meaning | Exercised here? |
|---|---|---|---|
| 0 | block temp | block temperature °C | yes |
| 1 | lid temp | lid temperature °C | yes |
| 2 | cycle count | **number of cycles** in the running protocol | see below |
| 3 | cycle number | **current cycle**, 1-based | yes |
| 4 | step text | current step's command text, verbatim | yes |
| 5 | step number | that step's 1-based number in the run definition | yes |
| 6 | run descriptor | `"<NAME>",<method>,<lid on>` | yes |
| 7 | **status register** | 8-bit flag word — decoded below | 5 of 256 values |
| 8 | protocol elapsed | **total elapsed run time, s** | yes |
| 9 | step elapsed | seconds elapsed in the current step | yes |
| 10 | protocol estimate | **estimated protocol time, s — remaining, on this instrument** | yes |
| 11 | ramp elapsed | seconds spent ramping toward this step's setpoint | yes |
| 12 | hold elapsed | seconds held at setpoint in this step | yes |
| 13 | paused | a dedicated pause flag, alongside bit 1 of field 7 — **read the bit, not this** (§7.9) | `0` throughout — never paused |
| 14 | errors | `:`-separated block error codes; a lone `0` means none | `0` throughout — no errors |
| 15 | step count | **number of steps in the run definition** | yes |
| 16 | sample temp | calculated sample temperature °C | yes |
| 17 | lid position | `OPEN`/`CLOSED`/`OPENING`/`CLOSING`/`MANUAL`/`STOP`/`ERROR`/`NONE`/`UNKNOWN` | 4 of 9 |
| 18 | sensor | an unidentified sensor reading | `0` throughout |
| 19 | result code | the usual `0000` | yes |

Two of these were guessed wrong by earlier passes of this document and are corrected here: field 7
is a flag word and never was a block count, and field 15 is the protocol's **step count**, not a
"run-active flag" that happened to read `6`. The capture's protocol is
`TEMP 95.0,180`, `TEMP 95.0,10`, `TEMP 55.0,30`, `PLATEREAD #h3F`, `GOTO 2,1`, `END` — six
directives (§7.2), and field 15 reads exactly `6` in all 300 running samples and `0` when idle. It
is the denominator for "step *n* of *m*", and `END` counts.

**Fields 2 and 3 are a count and an index, but this capture cannot separate them** — they are
byte-identical in all 507 running samples, both walking `0` → `1` → `2` on a protocol whose
`GOTO 2,1` gives two passes. Field 3 is unambiguously the current cycle (it advances in step with
the plate reads); whether field 2 is genuinely a total that coincidentally matches, or this
firmware simply echoes the same number twice, is not decidable from one run. Read field 3 for the
current cycle, and take the total from the protocol you authored rather than from field 2 — see
`protocol.md` §9, which reaches the same conclusion from the other direction.

#### Field 7, the status register

Eight independent flags, not an enumeration:

| Bit | Value | Meaning |
|---|---|---|
| 0 | 1 | **at target** — the block has reached the current step's setpoint |
| 1 | 2 | **paused** — the pause indicator to use; field 13 nominally reports the same state, but see §7.9 |
| 2 | 4 | a fourth-block flag, meaningless on a CFX96 |
| 3 | 8 | **lid preheating** |
| 4 | 16 | **incubating** — holding a temperature outside a protocol |
| 5 | 32 | **protocol running** |
| 6 | 64 | **block active** |
| 7 | 128 | **protocol cancelled** — **measured** (§7.8): set on top of the finished state when the run was aborted rather than allowed to complete |

Three coarse states are worth deriving from bits 4, 5 and 6. **Idle** is all three clear.
**Running** is block active and protocol running set, with incubating clear. **Finished** is
protocol running set with block active clear. Every value this capture produced decodes cleanly:

```
  0 = 0x00   idle
104 = 0x68   protocol running + block active + lid preheating   ← the §7.3 preheat
 96 = 0x60   protocol running + block active                    ← ramping
 97 = 0x61   protocol running + block active + at target        ← at setpoint, and during a read
 32 = 0x20   protocol running, block no longer active           ← the §7.6 finished state
160 = 0xA0   the same, plus protocol cancelled                   ← the §7.8 aborted state
```

The last two are worth noting. The finished-but-unacknowledged state of §7.6 is not an odd corner
the firmware backed into, it is the register's own "completion" encoding — and `160` is that same
encoding with bit 7 added, which is **the one place in the whole system that says a run was
aborted**. Nothing in the run's files records it: an aborted run writes the same `ended` marker as
a completed one and its `.alf` report reads clean (§7.8 step 7). The bit is also gone as soon as
the instrument returns to the empty-name idle, so a client that wants to know must be watching at
the time. Measured on a live CFX96: a run cancelled during its second thermal step went `96` →
`160`, against the `32` a normal completion gives. **Bit 0 is the cleanest
"has the block arrived" signal in the protocol** — better than comparing field 0 against a setpoint
parsed out of field 4 — and bit 3 is the honest way to detect the preheat. The `96` that made
"block count" tempting is a coincidence with the 96-well block; the number of blocks is 1 here, and
`BLOCKCOUNT?` (§3) is where that number actually comes from.

#### Field 16, the sample temperature

**It is a modelled sample temperature, not a repeat of the setpoint.** It settles on exactly `55.00`
and `95.00`, which invites the setpoint reading, but through a ramp it *lags* the block: block
19.36 → 27.22 → 31.35 → 35.82 while field 16 reads 17.15 → 20.14 → 22.91 → 26.52. That is a thermal
model of the well contents, which is what `CALC` (`protocol.md` §3.2) means — and it is why the
public app labels it `Sample*` with a footnote rather than presenting it as a measurement.

#### Fields 8–12, the four clocks

Four of the five nest: field 8 times the whole protocol, field 9 the current step, and fields 11
and 12 split that step into its ramp and its hold. Field 10 is the odd one out — an estimate rather
than a measurement.

- **Field 8, protocol elapsed** — counts up from `0.00` for the life of the run. Well behaved
  throughout; the best input to a progress bar.
- **Field 11, ramp elapsed** — runs while the block approaches the setpoint and freezes on arrival,
  the same instant bit 0 of field 7 sets.
- **Field 12, hold elapsed** — then counts up to the programmed hold: `TEMP 55.0,30` walks it from
  0.60 to 29.98 before the step advances.
- **Field 9, step elapsed**, is in principle the whole step, ramp included, and so should exceed
  field 12. On this firmware it does not: across all 507 samples the two differ by at most 0.01. On
  a CFX96 both read "time held at this setpoint", and a client should not rely on the distinction.

Field 8 counts up and field 10 counts down, both in seconds, and while both are ticking their sum
is constant — 350.88 … 350.97 across the 30 samples before `PROCEED` intervenes. That is what
identifies field 10 as **time remaining** rather than a total, and the two ways the sum *does* move
are exactly the caveats below: it steps down when the instrument re-plans (to ~171.5 after
`PROCEED` cut the initial hold), and it creeps up by whatever field 10 declines to count during a
plate read (171.48 → 185.46 over the run's two reads, so ~7 s a read here).

> **One portability caveat.** Field 10 is an *estimate of the protocol's time*, and this instrument
> transmits it already net of elapsed time. That appears to be a property of this block rather than
> of the field — elsewhere in the product line the same position is treated as a total from which
> elapsed time still has to be subtracted. Nothing here can test that, and a CFX96 client does not
> need to; but do not carry the "it is remaining" reading to another instrument without re-checking
> that field 8 + field 10 holds constant, which is a two-minute test.

**So a client does not have to compute time remaining — but it cannot display field 10 raw
either.** Three measured behaviours:

- **It is frozen for the whole lid preheat.** Field 10 sat at exactly `350.76` for 168 s, from the
  first non-idle poll until the block finally moved, while field 8 stayed at `0.00`. This is the
  field §7.3 notes "does not tick during this phase". A naive countdown looks hung for the first
  three minutes of every run.
- **It does not tick through a plate read.** Across a 15.2 s `PLATEREAD #h3F` it moved 77.26 →
  76.45. It reached `0.00` 13.8 s before the run actually ended, during the final read.
- **It re-plans.** When `PROCEED` (§7.5) cut the 180 s initial hold short, field 10 jumped
  314.26 → 136.91 on the very next poll — the instrument re-derives it rather than replaying a
  fixed schedule.

Once ticking it is usable but consistently optimistic: across the 117 samples where the block was
thermally active after the `PROCEED` re-plan, `now + field 10` predicted the end of the run
**6.5 to 21.1 s early**, never late, and the error grew as each plate read went uncounted. Whether
that shortfall keeps compounding is **untested** — the only run captured here has two reads, and a
45-cycle protocol has 45. If it does, a long run would under-report by minutes by the end. Round
the display to a `mm:ss` that does not pretend to second-level precision.

**Recommended display.** Show field 10 as the source of truth, formatted `mm:ss`, and handle the
two windows where it stalls rather than trying to correct it:

1. While **bit 3 of field 7** is set, show "Preheating lid" instead of a countdown — the number
   behind it is a plan, not a clock. Test the bit rather than the whole byte: `104` is only the
   value this run happened to produce, and any of the other flags could accompany it.
2. During a `PLATEREAD` step, expect the countdown to hold; do not treat it as a stall, and do not
   let it drive a "finished" state — `0.00` is not the end of the run. §7.5's step transition and
   §7.6's `CANCEL` state are the real signals.
3. Elapsed (field 8) is well behaved throughout and is the better input to a progress bar, since
   the protocol's step list is already known locally and gives a denominator.

A client that wants a *stable* estimate — one that does not jump when the instrument re-plans — can
compute one from the protocol it just authored and calibrate it against the per-step wall times in
a previous run's `.alf` (§5.2, [`alf.md`](./alf.md)), whose per-step timestamps give ramp and
plate-read costs directly. That is worth doing only if the drift above turns out to matter;
field 10 alone is sufficient for a readout.

> **What these captures do not exercise.** Every field above is named, but three are never anything
> but `0` here, so their *format* rests on the field map rather than on observation: field 13
> (paused — nothing in either capture pauses a run), field 14 (the `:`-separated error list —
> nothing errors), and field 18 (the sensor reading, whose units and source are unidentified). Of
> field 7's eight flags, three are never seen set (paused, fourth-block, incubating) — **bit 7,
> protocol cancelled, is no longer among them**: §7.8's aborted run sets it — and
> five of the nine lid positions never occur. A client should parse them as documented but treat
> the first non-zero value it ever sees from any of them as worth logging rather than trusting.

### 3.3 `RTSTATUS?` — the optical head's status

The second member of the polling loop is a much smaller record: a fixed pair of temperatures
followed by a variable-length fault list.

| # | Meaning |
|---|---|
| 0 | **shuttle temperature °C** — the optical head's own heated shuttle |
| 1 | **ambient temperature °C**, measured at the upper board |
| 2 … *n*−1 | **fault entries**, one per field, `<hex code>[,<extra>]`; normally a single empty field |
| *n* | the usual `0000` result code |

So `18.31;26;;0000` is shuttle 18.31 °C, ambient 26 °C, no faults. **The empty third field is the
healthy reading, not a truncated response** — the list is present and empty, which is why the
response has four parts rather than three. Fault codes are hexadecimal and carry a subsystem tag in
their high half-word, with an optional comma-separated second value for extra detail; a client that
does not decode the subsystem should still surface the raw code. Neither capture contains a
populated fault list, so that half of the format is documented but unobserved.

**The shuttle temperature is the useful one, and it moves.** §7.3 explains the run start in terms of
the lid preheat, but that is only half of it: over `usb-run`'s 506 samples the shuttle climbs
**18.31 → 45.38 °C**, starting its rise inside the same preheat window the lid does and levelling
off around 45.2 °C once the block is cycling, then decaying after the run ends. In `usb-basic`,
where nothing runs, it sits at ambient the whole time (17.05–17.49 °C). So a client that wants to
explain the delay before the block moves has both numbers: lid from `STATUS?` field 1, shuttle from
`RTSTATUS?` field 0, and neither is at target when a run begins.

Field 1 is a coarser measurement — an integer, drifting 22–27 over the run and 23–24 while idle,
with no clear correlation to the thermal work. Treat it as a chassis-ambient reading, not an
instrument of anything.

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
The `.alf` is a run report; §5.2 covers the directory it comes from and
[`alf.md`](./alf.md) the file itself.

**A zero-byte file's `GETFILE` reply is unreliable — observed live, not in the reference
capture.** `\Storage Card\CurrentRun`'s `begun`/`ended` markers (`runFolder.ts`) are zero-content
by design, and asking for one after a reconnect-mid-run (which re-fetches every name, having lost
its cache) has been seen to leave `GETFILE`'s reply unanswered until the client's own reply timer
gives up — up to a minute per marker, stalling the fetch loop on that one name. The instrument's
side of this is unconfirmed (no capture exercises it); the client-side fix is to skip the
`GETFILE` round-trip entirely once `GETFILESIZE` answers `0`, since there is nothing to transfer
either way (`device.ts`'s `getFile`).

### 5.2 `\Storage Card\PCRunReport` — the run report, and what an `.alf` says

`\Storage Card` has only two directories (§5), and this is the second one. It is not a general
log store and it is not where a run's data lives: `\Storage Card\CurrentRun` holds the run
(fluorescence, protocol, calibration, markers), and `PCRunReport` holds **one small text file
summarising how the block behaved** while that run executed. In every observation it contained
either nothing or exactly one `.alf`. **Reports persist until something deletes them**: the
pre-run listing in §7.1 found the *previous* run's report (a `GRADIENTTEST.alf` from six days
earlier) still sitting there, which is why §7.1 empties the directory rather than trusting the
newest name. The new report was present when the directory was listed after the run ended;
nothing listed it mid-run, so exactly when during the run it materialises is unmeasured — a client
that wants certainty should clear the directory first and treat the reappearance of any entry as
the signal.

The name is `<yyyymmdd>_<hhmmss>_<serial>_<RUN NAME>.alf` — start timestamp, the base-unit serial
`*IDN?` reports, and the run name from `RemoteRun`'s operand 4 in full (uppercased, unlike the
8-character truncation `STATUS?` shows). Reading it needs nothing new: `GETFILESLEN` +
`LISTALLFILES` to find the name, `GETFILESIZE` + `GETFILE` to pull it, and `DELFILE` to clear it.
Sizes seen are small — 693 bytes for a 2-cycle run, ~7 KB for a 45-cycle one — because the file
grows with the number of protocol steps executed, not with plate size or channel count.

**The same report is also copied into `\Storage Card\CurrentRun`**, which means a client that
takes the whole run directory (`zpcrFromRunFiles`, §7.7 step 10) already has it. Worth knowing:
that copy has been seen in the run folder of a run started **from the instrument's own
touchscreen**, so the report is a property of any run, not of PC-driven ones — despite the "PC" in
the directory name. Whether a front-panel run also deposits a copy into `PCRunReport` is untested.

**The file's contents are [`alf.md`](./alf.md)** — the `.alf` run report is not USB-specific (it
travels inside every `.zpcr`), so its format lives in its own doc: a header line of run identity,
the protocol as executed, an error summary, and one line per executed step with that step's
setpoint, nominal hold and wall-clock start. Two things worth knowing from here: the header echoes
back what `RemoteRun` was told (its operands 4 and 5, plus `ALPHASN?`/`BASESN?`), so it is an
independent record of what the instrument thought it was asked to do, and the step lines'
timestamps are the only per-step timing the instrument ever reports — §3.2 wants them for the same
reason.

**Two related names exist that this capture never exercised**, both worth trying before assuming
they are absent: a `LASTRUNREPORT <serial>,<block letter>` command, which by its shape would answer
with the most recent report's filename and would remove the need to list-and-guess; and a sibling
`\Storage Card\RunReports` directory addressed the same way (`GETFILESIZE`/`GETFILE`), plausibly
where models other than this one keep the same thing. Neither appeared on the wire here, so both
are unconfirmed — a client should treat `PCRunReport` plus `LISTALLFILES` as the path that is known
to work.

## 6. What's still a real gap

The captures used here never triggered the optical head's own scan command surface. Both plate
reads in `usb-run` came from firmware executing a `PLATEREAD` step already baked into the authored
protocol (§7.2), autonomously, with the result simply pulled off afterward as a file — the host never had
to speak to the optical head directly. That is not incidental: it is what `RemoteRun`'s
`<sierra mode>` operand asks for (§7.3) — the instrument runs the protocol *and* its own optics,
and the host collects files.

**This means a WebUSB client that only needs to run an existing protocol and collect its plate
reads does not need to reverse the optical protocol at all** — §2 through §5 are sufficient for
that, provided it starts runs in that mode. Only a client that wants to trigger a scan *outside* of
a running protocol (a manual single-read, or calibration) would need §4 characterized further, or a
capture that actually exercises that path.

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

A seventh path leaves the same way early: **§7.8, stopping a run in progress** — the same `CANCEL`,
with different rules about when to send it and what is left to collect.

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

Eight positional operands, comma-separated, each quoted:

| # | Operand | Type | Meaning |
|---|---|---|---|
| 1 | `<block>` | `A` or `B` | which block. A base unit carries at most two, lettered `A` and `B`; `BLOCKCOUNT?` says how many exist, and a CFX96 has one, so `"A"`. This is the same letter `ERRORLIST A` takes |
| 2 | `<lid on>` | `True`/`False` | **run the heated lid.** `HOTLID` (§7.2) sets its temperature; this decides whether it is used at all. `STATUS?`'s run descriptor echoes it as the third element — `"SINGLETE",CALC,ON` while running, flipping to `OFF` when the run ends and the lid heater is released |
| 3 | `<remote start>` | `True`/`False` | **start it at the instrument, not from here.** `False` (this capture) means run *now* — measured below. `True` is the language's "prepare the run and wait for someone to press start on the instrument's own touchscreen", the front panel's counterpart to the host's start; it is what a client declines by sending `False` |
| 4 | `<run name>` | string | the run's name, and the only place it is given — `PROTOCOL`'s operand is not it (§7.2). It reaches `STATUS?` (uppercased and truncated to 8 characters: `singletest` → `"SINGLETE"`) and the report's filename in full (`…_SINGLETEST.alf`), so keep it to characters that are safe in a filename. Filenames are *all* it reaches: nothing in the run's own metadata records it, which is why this project also deposits it as a `zpcrweb.json` (§7.4) |
| 5 | `<user>` | string | the operator, recorded in the run report. Free text; `admin` here |
| 6 | `<sample ID>` | string | free-text sample/plate identifier, empty in this capture |
| 7 | `<sierra mode>` | `True`/`False` | **run autonomously.** `True` — the instrument owns the whole run, driving its own optics at each `PLATEREAD` step and writing each `Read0000N.Plateread` to its own storage, which is why the host never speaks to the optical head (§6) and why the run survives the host going away: everything it produced is on the instrument to be collected whenever. `False` is the non-autonomous mode, in which the optical head is *not* the instrument's own business — and driving it is the gap §6 describes, so a client has no reason to ask for it |
| 8 | `<method>` | `CALC`/`BLOCK`/`OTHER` | the same thermal-control method already sent as `METHOD` (`protocol.md` §3.2), repeated here. Not redundant in practice: it is this copy that `STATUS?` reports back, as the second element of the run descriptor |

**Types are strict.** The booleans are the literal words `True`/`False` (case-insensitive; nothing
else parses — not `1`/`0`, not `ON`/`OFF`), and `<method>` is one of the three enumerated names.
None of the strings may contain `'`, `"`, `,` or `;`: the first two are the operand quoting, the
third is the operand separator, and the fourth is the response's value/error separator — a name
carrying any of them either breaks the command or corrupts the reply that comes back. The same
`assertCommandArgument` reasoning as §10 applies, one layer up.

Operands 1, 4, 5 and 8 are corroborated by the capture's own echoes (`STATUS?`, the `.alf`); 2, 3
and 7 are defined by the command language but never *varied* here, so their off-values are
undemonstrated — §9.

**The run starts on this command, with nothing further required.** Measured: `RemoteRun` returned
`0000`, and 11 s later `STATUS?` left `IDLE` for
`…;1;1;TEMP 95.0,180;1;"SINGLETE",CALC,ON;…` — cycle 1, step 1, and the run descriptor built out of
operands 4, 8 and 2. No confirmation, no second command.

What follows the start is the lid: for the next ~180 s the lid temperature climbs 19 → 95 °C while
the block sits at ambient 17 °C, and only then does the block ramp. A client that expects to see
block temperature move immediately will think the run has hung. `STATUS?`'s clocks do not tick
during this phase either: elapsed (field 8) stays at `0.00` and time-remaining (field 10) holds at
its initial plan for the full 168 s — §3.2, which is why a countdown needs a "preheating" state of
its own.

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

**What this project deposits instead** (`packages/core/src/usb/runPlan.ts`, `planRun()`): the same
idea, three files, none of them encrypted.

| # | File | What it is |
|---|---|---|
| 1 | `<protocol>.prcl.txt` | the protocol as the plaintext run definition of `prcl.md` §3.1 |
| 2 | `<plate>.plt.csv` | the plate map as this project's plate CSV |
| 3 | `zpcrweb.json` | what the run is *called* (`zpcrweb-json.md`), written only when it has a name |

The first two are named after the protocol and the plate themselves, not after the run: those are
reused across runs and arrive with names of their own. The third exists because operand 4 of §7.3
is the only channel a run's name has, and it reaches nothing but the instrument's composed
filenames — no field of `RunInfo.xml` records what a run is called. Depositing the name means the
`.zpcr` the folder becomes states it, so it survives a reload, a rename on disk, or another
machine. `RunInfo.xml` and `GlobData.xml` are not written: the instrument writes its own
`RunInfo.xml`, and the host inventory describes a PC application this isn't.

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

**Which half is which is measured, not inferred.** The captures alone could not establish it: every
file they upload has an **odd** byte length (17,299 / 1,821 / 8,751 / 1,291), and on an odd length
the formula above is indistinguishable from the degenerate CRC-16 with polynomial `x^16 + 1` — a
register that XORs in each byte and rotates right eight times, which is a far more likely thing to
find behind a command named `GETFILECRC`. The two agree on every odd-length input and swap the two
halves on every even-length one. Five even-length files uploaded to a C1000 (serial CT019138)
settle it in favor of the interleaved XOR above; see §9.2. **It is not a CRC**, despite all three
command names.

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

**Skipping out of a loop takes more than one `PROCEED`.** Inside a `GOTO` loop a single skip only
advances one step of one pass, so leaving the loop means issuing `PROCEED` repeatedly, watching the
cycle and step counters (`CNUMBER?`/`SNUMBER?`, which can be sent as one `;`-joined line and answer
as one `;`-separated reply) until the step index passes the loop's closing `GOTO`. There is also a
two-token `STATUS PAUSE` / `STATUS UNPAUSE` form — distinct from the `STATUS?` query — used to
bracket that burst, apparently so the run's own bookkeeping does not race the host's step changes.
Neither capture contains either form, so their exact effect is unverified; the bracketing pattern
is noted here because a client that drives steps by hand mid-run will likely need it, and because
`STATUS` with an operand is otherwise easy to mistake for a typo.

### 7.6 Finishing

When the protocol completes, `STATUS?` reports a state that is neither running nor truly idle:

```
…;0;0;IDLE;0;"SINGLETE",CALC,OFF;32;192.13;…      finished, still holding the run
…;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;…                 idle — after CANCEL
```

The step is `IDLE` and the cycle counters are 0, but the **run name is still attached** and the
method still reads `CALC` — the instrument is holding the finished run. The two fields after the
descriptor say the same thing: the state code is `32`, its run-attached bit without any of the
thermal ones, and elapsed still reads the run's final `192.13` (§3.2). `CANCEL` clears all of it to
the empty-name `"",BLOCK,OFF` idle of §3. So `CANCEL` here is an acknowledgement, not an abort; §3
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
directory it is the only entry. It is small (693 bytes here); **[`alf.md`](./alf.md) decodes it** —
a header summary line, the protocol as executed, an error summary, and one line per executed step
with its setpoint, nominal hold and the wall-clock time that step began. The same `.alf` is also
copied into `\Storage Card\CurrentRun`, so a client taking the whole folder gets it either way.

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
   than just fluorescence — or this project's plaintext equivalents, plus a `zpcrweb.json` naming
   the run. Skip it otherwise.
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

A client that also offers a **Stop** button needs one more step, §7.8.

### 7.8 Cancelling a run in progress

> **Evidence strength, stated up front.** This section was written as a specification to verify,
> and has since been **measured against a live CFX96** — a two-cycle run aborted from the host
> during its second thermal step, captured in full (`usb-cancel`, see the Provenance note at the top). What
> the measurement changed:
>
> - **`CANCEL` does abort a thermally active protocol.** Confirmed. The run stopped 2.6 s after
>   the command, and the status register went `96` → `160`, i.e. the finished encoding plus bit 7
>   (§3.2). That bit had never been observed set before.
> - **A `CANCEL` sent in the start window is accepted and ignored** — new, and the single most
>   consequential thing here. It is now step 0 below.
> - **Step 7 was wrong.** The `.alf` report's user-aborted flag reads `False` on a genuinely
>   aborted run, and its sentinel line still says `Protocol completed.` The report is *not* where
>   the abort is recorded — nothing in the run's files is. Step 7 has been rewritten and step 6's
>   read-count rule is now the only durable evidence.
> - **A full stop takes two `CANCEL`s**, not one: the abort, then §7.6's acknowledgement.
>
> Still unmeasured: `CANCEL` on a *paused* run and on an `INCUBATE` hold, and whether a read
> interrupted mid-scan leaves a partial file behind. Step 1 exists so the last of those stays
> hypothetical.

**The command is `CANCEL`, and there is no other.** The run-control group is `RemoteRun`, `PAUSE`,
`RESUME`, `PROCEED`, `CANCEL` — nothing else in the language ends a protocol, and the register bit
named for a cancelled protocol is the state it is expected to produce. `CANCEL` is a pure action
command: the reply is the bare `0000`, no semicolon (§3).

Cancelling is therefore the *same* command as acknowledging a finished run (§7.6). The difference
is entirely in what surrounds it — what you wait for before sending it, and what is left to collect
afterwards.

**0. A run that has been *asked for* may not be running yet — and a cancel there does nothing.**
Measured: `RemoteRun` was accepted at t=0.0 s and `STATUS?` went on reporting the empty idle
(register `0`) until t=6.1 s, when the block began its first ramp. A `CANCEL` sent at t=4.5 s,
inside that window, was answered `0000` — and the run started anyway 1.6 s later and cycled on.
The reply says nothing; there was simply no protocol running for it to end.

This is the failure mode a Stop button is *most* likely to hit, because the window sits exactly
where an operator realises they have started the wrong run. A host cannot detect the window from
`STATUS?` — an armed-but-not-started run and a genuinely idle instrument are the same reply — so
**it has to remember that it asked for a run**, and keep watching until either the run appears (and
can then be cancelled for real) or enough time passes that it clearly never will. ~6 s is the one
measured figure; allow several times that. `CfxDevice.cancelRun`'s `expectStart` is this rule.

**1. Don't cancel into a plate read.** While `STATUS?`'s current-step field reads
`PLATEREAD #h<mask>`, the optics are mid-scan and the `Read0000N.Plateread` file **does not exist
yet** — it appears when that step ends (§7.5). Cancelling there loses that read, and possibly
leaves a partial file. A clean stop waits for the step field to change; a read step is seconds, not
minutes, so the wait is short. If the user wants it stopped *now*, cancel anyway and treat the
in-flight read as lost — but say so, rather than silently returning a run with a missing cycle.

**2. Clear any pause first.** If field 13 is set, or bit 1 of the status register is, the run is
paused. Send `RESUME`, confirm the flag clears on the next poll, then cancel. Whether `CANCEL`
alone ends a paused run is untested — resuming first costs one command and one poll and removes
the question. (Ending a paused run *without* resuming it first is exactly the case where an
untested path would bite: the block is holding, not cycling, and it is the state a stop button is
most likely to be pressed in.)

**3. Send `CANCEL`.** Expect `0000`.

**4. Wait for idle in `STATUS?`, not for a fixed delay.** The target is the empty-name idle of §3:

```
…;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;<temp>;CLOSED;0;0000
```

— step `IDLE`, both cycle counters `0`, the run descriptor back to `"",BLOCK,OFF`, and the status
register `0`.

**Getting there takes two `CANCEL`s.** Measured: the first one stops the protocol and leaves the
instrument in §7.6's *finished* state — `IDLE`, cycle counters `0`, but **the run name still
attached** and the register reading `160`. That is the abort; the `ended` marker and the `.alf`
report are not in the run folder yet. The second `CANCEL` is §7.6's ordinary acknowledgement,
after which they appear. A client that already implements §7.6 should therefore stop here and let
its existing end-of-run path take over — otherwise the acknowledgement has two owners and the
final read can be collected twice or not at all. (`CfxDevice.cancelRun` stops here for exactly
that reason; `useRunWatch` does the rest.)

The register value on the way through is **`160`**, not `128` — bit 7 arrives *on top of* the
finished state's bit 5, and it is the one signal that distinguishes "the run I stopped" from "the
run that finished while I was deciding". Catch it live or not at all: it is gone once the
instrument reaches the empty-name idle, and it is written nowhere.

The block does **not** have to reach any temperature first — the thermal state simply stops being
driven — but do not re-arm the instrument on a timer: poll until the descriptor is empty. Allow
generously before declaring it stuck; the desktop software gives the wind-down minutes, not
seconds, and a stop issued during a read has to let the optics finish before anything else
happens.

**5. `ERRORS?` and `ERRORLIST A` once, after.** A user-initiated stop is not a fault, so both
should stay clean (`0;0000` and `;0000`). A non-zero here is the instrument complaining about
something *else*, and it is worth surfacing separately rather than folding into "run cancelled".

**6. Collect what the run did produce — the folder is a normal run folder.** Re-list
`\Storage Card\CurrentRun` with the mandatory adjacent `GETFILESLEN` + `LISTALLFILES` (§5), and
pull every `Read0000N.Plateread` not already taken. Reads that completed before the cancel are
whole, ordinary files; a cancelled run is simply a run with **fewer reads than its protocol
implies**, which is why the read count — not any flag in the fluorescence data — is what tells a
reader the run was short. `ended` **is** present in the listing — confirmed on the aborted run —
the same marker a completed run gets: it means "no longer in progress", not "completed
successfully". It appears only after the §7.6 acknowledgement of step 4, alongside the `.alf`.

**7. Pull the `.alf`, but do not expect it to say the run was aborted.** From
`\Storage Card\PCRunReport\`, exactly as in §7.6 — it is worth having for its per-step timings,
which stop at the last step that executed.

**It does not record the abort.** This section previously claimed the error line's user-aborted
flag reads `True` (`alf.md` §6, line 3 field 4); measured on a genuinely aborted run, **it reads
`False`**, the summary text is the ordinary ` No errors reported. `, and the sentinel line says
`Protocol completed.` — with a timestamp equal to the moment of the cancel rather than of any
completion. The whole line is byte-identical to a clean run's. What that flag *is* for remains
unknown; a stop from the instrument's own touchscreen, or one the instrument initiated itself
after a fault, may well set it, and neither has been captured. Read it if it is `True`; do not
read `False` as "this run finished".

So the durable evidence is **step 6's read count and nothing else**. This project's reader
implements exactly that comparison (`runCompleteness` in `packages/core/src/runFolder.ts`): a run
whose archive holds fewer `Read0000N.Plateread` files than its own protocol implies stopped short.

**A client must not assume its own `CANCEL` explains every early end it sees** — an operator
standing at the instrument can stop the run, and a client that only ever polls `STATUS?` will
observe the run vanish with no command of its own to blame it on. Report an unexplained early end
as "the run ended early", because that is genuinely all that can be known offline.

**8. `FRONTENDLOCKED OFF` if you locked it** (§7.6) — a stopped run releases the touchscreen the
same as a finished one.

**9. The partial run zips like any other.** `\Storage Card\CurrentRun` after a cancel holds
`begun`, `ended`, the reads that happened, `ProtocolName.txt`, the calibration files and whatever
was deposited in §7.4 — a plain ZIP of that directory is a valid `.zpcr` describing a short run.
Nothing about the container marks it partial; the read count and the report's abort flag do.

**What does *not* need undoing.** A run started the §7.3 way has the instrument managing its own
fans and shuttle heater, so a host that never touched them has nothing to restore. A host that
*did* take those over on the binary auxiliary channels (§4) owns the tail of the run, cancelled or
not: return fan control to automatic with its on/off temperature thresholds, and switch the shuttle
heater off. That pairing — fans to auto, shuttle heat off, then read the block's error list — is
the end-of-run cleanup regardless of how the run ended.

**Cancelling before the run starts is not this.** Between authoring (§7.2) and `RemoteRun` (§7.3)
nothing is running: don't send `RemoteRun`. The authored protocol sits on the instrument inertly
and the next `PROTOCOL '<name>'` overwrites it. The same is true of a run armed with
`<remote start>` set — it is waiting for someone to press start at the touchscreen and has not
begun.

**An `INCUBATE` hold is a separate case.** Bit 4 of the status register is a temperature being
held outside any protocol. `CANCEL` is the natural reading of the vocabulary there too, but that
is an inference from grouping, not a measurement, and it is a different state from a running
protocol — verify it before relying on it.

### 7.9 Pausing and resuming

> **Evidence strength.** As with §7.8, neither capture pauses a run: field 13 and status-register
> bit 1 are `0` in all 666 replies. The commands and the state bit are established; **the
> transitions are not measured.** Two things below are firmer than the rest and worth separating
> out: the warning about `STATUS PAUSE` (a different mechanism that will not pause a run), and the
> fact that a remote-start-armed run *reports itself paused* — that one explains a state a client
> will meet on its very first run and should not be treated as a fault.

**Three commands, all aimed at the thermal block:** `PAUSE` suspends the running protocol, `RESUME`
continues it, and `PAUSE?` asks whether it is suspended. They sit in the same run-control group as
`PROCEED` and `CANCEL` (§3). By the response-shape rule, `PAUSE` and `RESUME` are actions and
should answer the bare `0000` while `PAUSE?` answers `<value>;0000` — but neither capture contains
any of the three, so unlike the commands listed in §3 this is the rule applied, not a byte-for-byte
observation.

Both are **no-ops when no protocol is running.** There is nothing to suspend outside a run, and a
client should gate its own Pause button on the running state rather than expect an error back.

#### Reading the pause state

There are two places a paused run shows up, and they are not equally trustworthy:

| Source | Use it? |
|---|---|
| **Status register bit 1** (`2`), §3.2 field 7 | **Yes — this is the pause indicator.** It is the one a working client should poll |
| `STATUS?` **field 13** | Not on its own. It is a dedicated pause field in the record, but it has never been observed non-zero, and nothing establishes that it tracks bit 1 in practice |
| `PAUSE?` | A direct query for the same state. Useful as a one-shot confirmation after sending `PAUSE`; redundant if you are already polling `STATUS?` at 1 Hz |

The safe reading is **bit 1 OR field 13** — treat either as paused — while trusting bit 1 for
anything that must be right. If the two are ever seen to disagree, that is new information worth
recording, not a state to act on: this document cannot say which one leads. The natural assumption
that field 13 simply mirrors the bit is exactly that, an assumption; it is flagged here rather than
stated in §3.2 because a client that polls only field 13 would show a paused run as running.

#### What a pause does to the run's bookkeeping

The one durable, offline-checkable consequence is in the run report: **each step line carries both
a "was paused" flag and a "time paused" count** (`alf.md` §7, fields 8 and 9). Paused time is
therefore *accounted separately from the hold* rather than silently swallowed by it — a 30 s hold
paused for 90 s is not logged as a 120 s hold. Those two fields are `False` and `0` in all 6,205
step lines of this project's whole sample corpus, which is worth saying plainly: **nobody has ever
paused a run that produced a file in this repo.** A paused run is the way to see them take another
value, and a client that pauses runs should expect them and check what they contain.

What the captures cannot settle, and a client should not assume:

- Whether the **total elapsed** clock (field 8) keeps running while paused, or freezes with the
  step clocks. The report's separate paused-time accounting suggests the step-level clocks stop;
  field 8's behaviour is a different question and is untested.
- Whether the **remaining-time estimate** (field 10) stops counting down. If it does not, a long
  pause will drive the countdown to zero while the run still has steps left — worth defending
  against in any UI that shows it (§3.2 already warns that field 10 hits `0.00` before the end of
  a *normal* run).
- Whether a pause is honoured **mid-ramp** or deferred until the block reaches setpoint.
- How long the block will hold its current temperature while paused, and whether anything times
  the pause out.

#### Do not pause into a plate read

The same rule as §7.8's first step, for the same reason: while the current-step field reads
`PLATEREAD #h<mask>` the optics are mid-scan and the file does not exist yet. Wait for the step to
change. There is no evidence that a pause is even honoured during a read.

#### `PAUSE` is not `STATUS PAUSE`

These are two unrelated mechanisms whose names collide, and confusing them is the likeliest mistake
in this whole area:

- **`PAUSE`** suspends the *run*. It is in the command vocabulary and pairs with `RESUME`.
- **`STATUS PAUSE` / `STATUS UNPAUSE`** (§7.5) is a two-token form of the status command used to
  bracket a burst of host-driven step changes. It is **not** in the command vocabulary, it pairs
  with `STATUS UNPAUSE`, and there is no reason to think it stops the protocol. A client that sends
  it intending to pause a run will most likely get `0000` back and a run that keeps cycling.

If you want the run suspended, send `PAUSE` and confirm bit 1.

#### The armed run reports itself paused

**A run started with `<remote start>` set (§7.3) sits in the paused state until someone presses
Start at the instrument's touchscreen.** This is the single most useful thing in this section,
because a client will meet it immediately: `RemoteRun` returns `0000`, the run does not begin, and
the status register shows paused. That is not a fault and not a pause the client issued — it is
"armed, waiting for a human".

The two are indistinguishable from the status reply alone. **The host tells them apart by
remembering what it asked for:** if it set remote start and has not yet seen the run leave the
paused state, the run is waiting to be started. The intended way out is the operator pressing Start
on the instrument; whether `RESUME` also releases an armed run is untested, and a client should not
rely on it. A client that does not want this state should leave `<remote start>` clear, in which
case `RemoteRun` starts the run immediately (§7.3, measured).

#### Pause and the other run-control verbs

- **Before cancelling a paused run, resume it** — §7.8 step 2.
- **`PROCEED` is not `RESUME`.** It skips to the next step (§7.5); it is not the way out of a
  pause, and there was nothing paused when the capture used it.
- **An indefinite hold is not a pause.** A `TEMP <°C>,0` step holds forever by design
  (`protocol.md` §3.2) and is reported as an ordinary running step — pause bit clear, block active,
  a step text whose hold operand is `0`. The way out of one is `PROCEED`, not `RESUME`, and a
  client showing "paused" for it would be lying to the user.

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

## 9. Appendix: provenance and single-observation caveats

### 9.1 Single-observation caveats

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
- **Pausing** (§7.9) — `PAUSE`, `RESUME` and `PAUSE?` appear in neither capture, and the pause
  indicators are `0` in all 666 status replies. The commands and the state bit are established;
  every transition, every effect on the clocks, and the relationship between field 13 and
  register bit 1 are not. The armed-run-reports-paused behaviour is the firmest claim there and is
  still not one this capture pair shows directly.
- **Cancelling a *running* protocol** (§7.8) — **now measured**, and the entry that used to sit
  here was wrong in one respect worth keeping visible: the `.alf` report's user-aborted flag reads
  `False` on a genuinely aborted run, so what *does* set it is still unknown (a stop at the
  touchscreen and an instrument-initiated stop are both uncaptured). Also still unobserved:
  `CANCEL` on a paused run and on an `INCUBATE` hold, and whether a read interrupted mid-scan
  leaves a partial file behind.
- **`GETPOS?`, `TESTMODE`, `SETAPILOGLEVEL`** (§3) — recorded with their literal observed
  values; the capture doesn't say more about what any of them mean than the command name itself
  suggests. (`BLOCKID` was in this list until the operator's own account of `usb-basic` — flash,
  open, close — identified it; see §3.)
- **Channel 0 and channel 2's byte layout** (§4) — both channels' examples are real and
  byte-exact, but with this little variation in the traffic, no individual byte's meaning is
  confirmed for either.
- **`RemoteRun`'s three booleans** (§3, §7.3) — the capture corroborates four of the eight operands
  positionally: `"A"` is the block letter `ERRORLIST A` also uses, `"singletest"` is the run name
  the resulting `.alf` report carries, `"admin"` the operator, `"CALC"` the method already sent as
  `METHOD`. What `<lid on>`, `<remote start>` and `<sierra mode>` *mean* is settled (§7.3), but
  each was sent with one value only — `True`, `False`, `True` — so **no off-value is
  demonstrated**: no run here was started from the touchscreen, run without the heated lid, or run
  non-autonomously. §7.3's account of what `False` for `<sierra mode>` would entail is the weakest
  claim in that table, and the one a client has no reason to test.
- **The run sequence** (§7) — one run, one operator, one instrument. The *ordering* claims are
  strong (they are what the wire did, and the run-starts-at-`RemoteRun` and `PROCEED`-skips-a-step
  findings each rest on a `STATUS?` transition, not on inference), but nothing here varies the
  protocol, the plate, `RemoteRun`'s booleans, or the failure paths. In particular: no run was
  aborted mid-flight, no step failed authoring, and no error code other than `0000` was ever seen,
  so what a client should do when something goes wrong is not documented because it was never
  observed. The pre-flight burst of §7.1 is likewise "what this client sends", not a demonstrated
  requirement — none of it changes instrument state.
- **`STATUS?`'s and `RTSTATUS?`'s quiet fields** (§3.2, §3.3) — the field maps are complete, but
  one run on one healthy instrument exercises only part of them. Nothing paused, nothing errored,
  no fault list was ever populated, the lid only ever took 4 of its 9 positions, and 4 of the
  status register's 8 flags were never set. The *positions and formats* of those fields are
  documented; what a populated error list or an unusual flag combination looks like in practice is
  not something these captures show.
- **`STATUS?`'s time-remaining field** (§3.2) — field 10 is measured against one run of two cycles
  and two plate reads. That it counts down, freezes through the preheat, stalls through a read and
  re-plans on `PROCEED` are all direct observations. What is *not* observed is whether the ~7 s
  it fails to count per plate read accumulates across a long protocol: on a 45-cycle run that would
  be minutes of drift, and no capture here has more than two reads to check it against. A client
  should not build a hard deadline on it.
- **`PLATEREAD #h<hex>`'s per-channel bits** (§3.1) — the mask's two *fields* are cross-checked
  (five runs, two configurations, three independent echoes of the value), and **bit 0 = channel 1**
  is measured directly from the one `#h81` run's all-zero channels 2–6. Bits 1–5 mapping to
  channels 2–6 in order follows by extension: no sample sets any of them individually, so nothing
  here would distinguish that ordering from another. Nor does anything here exercise bit 6, or a
  mask that is neither `#h3F` nor `#h81` — including the FRET (`#hA0`) and two-colour (`#h03`)
  configurations §3.1 names, which are the language's, not measurements.

### 9.2 Measuring the upload checksum's byte order

§7.4's checksum is stated as an interleaved XOR with the even-indexed bytes in the **high** half.
Which half is which cannot be read off any capture in this repository, because it only shows on an
even-length file and every file the captures upload is odd-length. The two candidate readings were
the interleaved XOR and the degenerate CRC-16 with polynomial `x^16 + 1`; they agree on every
odd-length input and swap halves on every even-length one.

Resolved on 2026-08-02 by uploading files of controlled length to a live C1000 (serial CT019138,
firmware 2.0.231.0, idle) with `CfxDevice.sendFile`, and comparing `GETFILECRC`'s answer against
both readings. Payload byte *i* was `(i × 37 + seed × 101 + 13) mod 256` with *seed* = the length,
sent to `\Storage Card\CurrentRun\zpcrweb_crc_probe.txt` and deleted afterwards:

| Length | Interleaved XOR | Shift-register CRC-16 | `GETFILECRC` |
| ------ | --------------- | --------------------- | ------------ |
| 2      | 55292           | 64727                 | **55292**    |
| 4      | 19158           | 54858                 | **19158**    |
| 16     | 208             | 53248                 | **208**      |
| 100    | 19126           | 46666                 | **19126**    |
| 1000   | 36936           | 18576                 | **36936**    |

Five for five on the interleaved XOR, none on the shift-register form. Three odd-length controls
(3, 101, 1001 bytes) matched as expected, and two further even lengths (256, 4096) were skipped
because both readings coincide there, so they discriminate nothing. `packages/core/test/runPlan.test.ts`
pins these vectors.

The earlier `x^16 + 1` hypothesis is therefore **wrong**, and so is the name: `CRCSENDFILE`,
`COMPUTEFILECRC` and `GETFILECRC` all traffic in a checksum that is not a CRC.

## 10. Implementation

`packages/core/src/usb/` implements §1–§7 as an isomorphic client, entry point `CfxDevice`:

| File | Covers |
|---|---|
| `frame.ts` | §2 — the 5-byte header codec, and `FrameReassembler`, which turns a direction's byte stream into complete logical messages. The only supported way to read this protocol; see §8 for the bug that parsing per packet causes. |
| `commands.ts` | §3 — command encoding and the two response shapes, plus `CFX_COMMANDS`, the action commands a UI might offer, each tagged with whether it was actually observed, and `assertCommandArgument`, which keeps a path from injecting a second command line. |
| `status.ts` | §3 — typed views over `*IDN?`, `STATUS?` and `RTSTATUS?`. Names every field §3.2/§3.3 give a meaning to, including the status register (field 7, decoded into `CfxStatusFlags` plus a derived `phase`), the four clocks (8–12) and `RTSTATUS?`'s shuttle/ambient temperatures and fault list — the raw `fields` array stays alongside them for the three still-unestablished ones (13's redundancy with field 7's paused bit aside, field 18's sensor reading has no known meaning). |
| `transport.ts` | §1 — the endpoint/interface constants and `UsbDeviceLike`, the structural interface both environments satisfy. |
| `crc.ts` | §7.4 — the upload checksum and its wire format. Its byte order is measured, §9.2. |
| `runPlan.ts` | §7.2–§7.4 as *data*: `planRun()` turns a run definition plus a plate into the exact command lines, the `RemoteRun` line and the files that would be deposited, and `checkRunPlan()` is the plate↔`PLATEREAD` compatibility check below. Pure — no device involved — which is what lets a UI review a run before any of it is sent. |
| `device.ts` | §3–§5 and §7 — the read pump, the command queue, the typed operations, `sendFile()` (§5's upload cycle), `startRun()` (§7.1–§7.4) and `acknowledgeRun()` (§7.6). |

**Starting a run is implemented, and its shape follows §7 rather than §5's.** `startRun()` clears
the old report (§7.1), types the protocol one directive per command (§7.2), sends `RemoteRun`
(§7.3) — after which **the run is going** — and only then deposits the files (§7.4). Two
consequences are worth stating because they read as bugs otherwise: a failure during the deposit
phase is *reported, never thrown*, since aborting a run that is already cycling because a
provenance file didn't copy would be the wrong trade; and there is **no confirmation step**, since
§7.5 measured `PROCEED` as "skip the current step" rather than the start confirmation §3 originally
guessed. Sending it after `RemoteRun` would silently skip the run's first step.

**What the client refuses to send.** `planRun()` checks the plate against the protocol's
`PLATEREAD` scan masks (§3.1) and blocks a start whose mask omits a channel the plate carries dyes
on. That combination is the one way a run goes wrong *silently*: it completes, reports no error,
and produces an archive in which those dyes are flat zero — indistinguishable afterwards from a
failed reaction. Reading channels the plate doesn't use is only a warning, since a deliberately
broad mask costs nothing but time.

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

`CFX_COMMANDS` in `commands.ts` is the action-command catalog a UI can offer: `BLOCKID 1` (flash
the indicator), `LID OPEN`, `LID CLOSE`, `PROCEED` (skip the current step, §7.5) and `CANCEL`
(§7.6), each tagged with how it is known to do what it says. All are `observed`; the tag exists so
that a future addition that *isn't* has somewhere to say so, and so a UI can mark it rather than
presenting a guess as a feature. It is no longer the *whole* of what a client can make the
instrument do — `startRun()` and `sendFile()` build command lines of their own — but it remains
the whole of what a client can do by pressing a button labelled with a command.

Still not implemented: §6's gap, unchanged. Nothing here drives the optical head directly, which
`<sierra mode>` (§7.3) is precisely what makes unnecessary for running a protocol.

### 10.1 The app

The Instrument view **stages a run** — pick the protocol and the plate from the app's loaded files
(a whole run supplies both, a `.prcl.txt` (`prcl.md` §3.1) or a `.pltd`/`.plt.csv` overrides either
half), review the exact directives that would be sent alongside the plate they'd run on — and now
starts it. The staged pair is fed through `planRun()` on every render, so the warnings shown
between the two halves and the state of the **Start run** button are the same object; a check that
blocks the start says why, in the place where the file that caused it is on screen.

**Following a run** is `state/useRunWatch.ts`, and it is the §7.5 rule rather than filesystem
polling: the status poll is already running, its current-step field carries the step's command text
verbatim, and the completed `.Plateread` appears when a `PLATEREAD` step *ends* — so the watcher
lists the run folder on that transition. Listing is entirely edge-triggered, never on a timer — a
periodic listing here once made the Start-run button visibly flicker, since a `GETFILESLEN`+
`LISTALLFILES` round trip holds the busy flag the button disables on. The one case §7.5 says the
transition rule alone cannot catch — the final read, whose transition is to `IDLE` — is caught by
the §7.6 acknowledgement instead, issued automatically when `STATUS?` reports the
finished-but-still-named state, because the last read and `ended` only appear after it. One more
listing establishes a baseline on connect: ordinarily it just records what the folder already holds
(usually a previous, finished run), but when that first listing is itself `begun` and not yet
`ended` — a reconnect made after a run had already started — it is pulled immediately rather than
waited out. Nothing lists on a run merely *starting*: `STATUS?`'s `running` flag already says that
live, and the marker files it would otherwise chase are a property of the archive this watcher
assembles, not of the rail's live state, so they can wait for whichever real edge lists next.

Each time the listing changes, the folder is pulled — **only the names not already cached**, since
28 of a `CurrentRun`'s ~40 files are the `.Dcal` set and never change — zipped with
`zpcrFromRunFiles` and handed to the store, which replaces the previous snapshot. The connection
therefore lives in `App`, not in the Instrument view: a run has to keep being followed while the
user sits in Curves watching its amplification curves arrive.

**"In progress" is never stored.** A run's `begun`-without-`ended` markers (§7.5) travel inside the
assembled archive, so `runProgressFromNames` reads the answer out of the file itself — which is why
the file chip's glow and the Overview banner are still right after a page reload, on a copy opened
on another machine, or with the instrument long since unplugged, and why nothing has to be told
when a run finishes. The app side is documented in `apps/web/ARCHITECTURE.md`, "The Instrument
view".
