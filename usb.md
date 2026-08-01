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
every query in §3 unchanged, and corrected three things the captures alone could not settle:
what `GETFILESLEN` actually returns (§3), that it is a *required prologue* to `LISTALLFILES`
rather than the sanity check it looked like (§5), and what the header's `passThrough` bit means
(§2). Those three are marked **measured live** where they appear.

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
  `LID OPEN`, `FRONTENDLOCKED`, `TESTMODE`, `BLOCKID`, and `SETAPILOGLEVEL` all responded `0000`,
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
| `STATUS?` | idle: `17.04;18.3;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;17.04;CLOSED;0;0000` — mid-run: `60.25;104.9;2;2;TEMP 95.0,10;2;"SINGLETE",CALC,ON;96;110.22;0.00;75.15;2.10;0.00;0;0;6;55.61;CLOSED;0;0000` | block temp, lid temp, cycle, step index, current step text, run name, method, lid state, block count, elapsed... — both examples are the complete response, not truncated |
| `RTSTATUS?` | `18.31;26;;0000` | shorter status, polled alongside `STATUS?` |
| `ERRORLIST A` | `;0000` | polled every cycle in lockstep with `STATUS?`/`RTSTATUS?` |

**Protocol authoring and run control:**

| Command | Notes |
|---|---|
| `PROTOCOL '<name>'`, `METHOD <name>` | names the protocol/method being authored — see §5 |
| `HOTLID <temp>,<ramp>` | e.g. `HOTLID 105,30` |
| `VOLUME <µL>` | e.g. `VOLUME 25` |
| `TEMP <°C>,<seconds>` | one hold step, e.g. `TEMP 95.0,180` |
| `PLATEREAD #h<hex>` | e.g. `PLATEREAD #h3F` — hex mask, presumably channel/dye selection; not decoded bit-by-bit |
| `GOTO <step>,<count>` | e.g. `GOTO 2,1` — loop back to step 2, 1 more time (2 total passes) |
| `END` | closes the step list |
| `ADDCYCLES <n>` | |
| `RemoteRun "<A>","<B>","<C>","<name>","<user>","<pw?>","<D>","<method>"` | e.g. `RemoteRun "A","True","False","singletest","admin","","True","CALC"` — starts the authored protocol running under a given run name/user |
| `PROCEED` | resumes/confirms a run (there was a ~2-minute gap between `RemoteRun` and `PROCEED` in the capture — almost certainly the operator closing the lid and confirming on the touchscreen) |
| `CANCEL` | seen once, immediately after the first plate read was pulled. The subsequent `LISTALLFILES` response only gains the `ended` marker and the second plate read (`Read00002.Plateread`) *after* this command — strong evidence this is normal run-finished cleanup rather than a user abort, though it isn't confirmed from firmware source |
| `LID OPEN` | issued on physical lid-open |
| `FRONTENDLOCKED ON`/`OFF` | `ON` appears once in `usb-basic`; `OFF` once, at the very end of `usb-run` |
| `TESTMODE <n>` | e.g. `TESTMODE 3`, issued at the very start of both captures |
| `BLOCKID <n>` | e.g. `BLOCKID 1` |
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

This is the practically important part for a WebUSB client that just wants to run an existing
protocol and pull results, and it's simpler than the ASCII `PROGRAM`/`TEMP`/`GOTO` authoring
commands in §3 might suggest: **the protocol and plate map are uploaded as complete files**, in
exactly the same encrypted-ZIP container this project's `.pltd`/`.prcl` parsers already decode
(see `pltd.md`, `prcl.md`, `zipcrypto.md`) — not built up command-by-command on the wire. `PROTOCOL`/
`METHOD`/`TEMP`/`GOTO` (§3) *were* also issued in the captured run, in parallel — CFX Manager
appears to author the run both ways (an ASCII step list *and* the equivalent `.prcl`/`.pltd`
files); which one the firmware actually executes wasn't determined from this capture, but the file
upload is the one that matters for reproducing a run without re-deriving the ASCII step grammar.

**Upload**, one command per file, no separate chunking protocol observed (small files went in one
message; see §2's note on message-vs-USB-packet size):

```
CRCSENDFILE "<crc>*<device path>",<raw file bytes>
```

`<crc>` is the client's own CRC of the file it's about to send — not a session ID or ticket number,
and not a length field. This is confirmed end-to-end, not guessed: `usb-run` uploaded four files,
and for every one of them, the CRC the device reports back after the upload (via
`COMPUTEFILECRC`/`GETFILECRC`, below) matches the `<crc>` CFX Manager sent up front, exactly:

| File | `<crc>` sent | Upload size | GUID `COMPUTEFILECRC` returned | `GETFILECRC` on that GUID |
|---|---|---|---|---|
| `GlobData.xml` | 24700 | 17,299 bytes (XML) | `fad4f43f-e127-4b35-857d-1aba9bd5a615` | `24700;0000` |
| `QuickPlate_96 wells_All Channels.pltd` | 05672 | 1,821 bytes (zip) | `0e72e6e2-5b85-4d00-b08a-41db67adaaa8` | `5672;0000` |
| `RunInfo.xml` | 49503 | 8,751 bytes (XML) | `e6328d75-08d1-406d-914f-88ea6dfa16df` | `49503;0000` |
| `singletest.prcl` | 46850 | 1,291 bytes (zip) | `988ed34b-647d-48be-ab4c-db6b1b3af9f0` | `46850;0000` |

That resolves what was previously two separate open questions about this sequence into one
mechanism. The full per-file sequence observed:

1. `DELFILE <friendly path>` — clear any stale file at the well-known name.
2. `CRCSENDFILE "<crc>*<friendly path>",<bytes>` — upload, `<crc>` computed by the client beforehand.
3. `COMPUTEFILECRC "<friendly path>"` — **despite the name, this doesn't return a CRC.** The
   device stores the just-uploaded file under a generated GUID name rather than the friendly one,
   and this is the call that hands that GUID name back: the response is `<dir>\<GUID>;0000`.
4. `GETFILESLEN`/`LISTALLFILES <dir>` — the host re-lists the directory. The GUID name is already
   in hand from step 3 by this point, so the *purpose* here looks like a UI refresh — but the
   pairing itself is mandatory, not incidental. See "Listing a directory" below.
5. `GETFILECRC "<dir>\<GUID>"` — the device's own CRC of the GUID-stored file, which the client can
   now compare against the `<crc>` it sent in step 2 to confirm the upload landed intact (table
   above).

The observed upload order across a run's four files: `GlobData.xml`, the `.pltd` plate map,
`RunInfo.xml`, the `.prcl` protocol.

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
- When `GETFILESLEN` does *not* return a length, the directory **cannot be listed at all**, and
  the correct move is to not send `LISTALLFILES` — anything it returned would be another
  directory's contents under this path's name. `\Storage Card` itself is the known case: it
  answers with a `passThrough` binary payload (§2) rather than a number, reproducibly. Why the
  volume root differs isn't established.

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
reads in `usb-run` came from firmware executing a `PLATEREAD` step already baked into the uploaded
protocol, autonomously, with the result simply pulled off afterward as a file — the host never had
to speak to the optical head directly. **This means a WebUSB client that only needs to run an
existing protocol and collect its plate reads does not need to reverse the optical protocol at
all** — §2 through §5 are sufficient for that. Only a client that wants to trigger a scan *outside*
of a running protocol (e.g. a manual single-read, or calibration) would need §4 characterized
further, or a capture that actually exercises that path.

## 7. Minimal sequence for a WebUSB client

Putting §1–§5 together, the shape of a client that loads and runs an existing `.prcl`/`.pltd` pair
and collects the plate reads:

1. `navigator.usb.requestDevice({ filters: [{ vendorId: 0x0614 }] })`, `open()`, `selectConfiguration(1)`,
   `claimInterface(0)`.
2. Send `*IDN?` (§3) over endpoint 2 OUT, read the response on endpoint 6 IN, to confirm framing
   and identify the unit. Read the IN endpoint with **one loop that reassembles and demultiplexes
   by channel**, not a read-per-command: channel 2 carries unsolicited traffic (§2, §4), so a
   per-command reader eventually returns a channel-2 payload as the answer to a channel-1 query
   and every reply after it is off by one.
3. Poll `STATUS?`/`RTSTATUS?`/`ERRORLIST A` (§3) — not strictly required, but this is what every
   real client does between commands and is a cheap liveness/error check.
4. Upload the plate map and protocol with `DELFILE`/`CRCSENDFILE`/`COMPUTEFILECRC`/`GETFILECRC`
   for each file (§5), comparing the CRC that comes back against the one sent — the well-known
   destination paths seen were under `\Storage Card\CurrentRun\`.
5. `RemoteRun "A","True","False","<name>","<user>","","True","<method>"`, then wait for the
   operator (or, for an unattended flow, whatever confirms lid closure) before `PROCEED`.
6. Poll `STATUS?` for step/cycle progress; each `PLATEREAD` step produces a new
   `Read0000N.Plateread` under `\Storage Card\CurrentRun\` — pull each with `GETFILESIZE` +
   `GETFILE` (§5) and decode with the existing `plateread.md`/`packages/core` parser. To discover
   them, list the directory with the mandatory `GETFILESLEN` + `LISTALLFILES` pair (§5), keeping
   the two adjacent.
7. After the run, pull the `.alf` report from `\Storage Card\PCRunReport\` the same way, if wanted.

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
- **`GETPOS?`, `TESTMODE`, `BLOCKID`, `SETAPILOGLEVEL`** (§3) — recorded with their literal
  observed values; the capture doesn't say more about what any of them mean than the command name
  itself suggests.
- **Channel 0 and channel 2's byte layout** (§4) — both channels' examples are real and
  byte-exact, but with this little variation in the traffic, no individual byte's meaning is
  confirmed for either.
- **`PLATEREAD #h<hex>`'s mask** (§3) — only `#h3F` was observed, in a protocol that reads all
  channels; which bit maps to which channel isn't determined from a single value.

## 10. Implementation

`packages/core/src/usb/` implements §1–§5 as an isomorphic client, entry point `CfxDevice`:

| File | Covers |
|---|---|
| `frame.ts` | §2 — the 5-byte header codec, and `FrameReassembler`, which turns a direction's byte stream into complete logical messages. The only supported way to read this protocol; see §8 for the bug that parsing per packet causes. |
| `commands.ts` | §3 — command encoding and the two response shapes, plus `CFX_COMMANDS`, the action commands a UI might offer, each tagged with whether it was actually observed. |
| `status.ts` | §3 — typed views over `*IDN?`, `STATUS?` and `RTSTATUS?`. Names only the fields whose meaning is established, and keeps the raw field array beside them for the rest. |
| `transport.ts` | §1 — the endpoint/interface constants and `UsbDeviceLike`, the structural interface both environments satisfy. |
| `device.ts` | §3–§5 — the read pump, the command queue, and the typed operations. |

**One implementation serves both a browser and Node.** node-usb ships a WebUSB implementation, so
a browser `USBDevice` and node-usb's satisfy the same structural interface and the environments
differ only in how the device handle is obtained — `navigator.usb` versus `new WebUSB(…)`. Nothing
above that line is environment-specific. `transport.ts`'s module comment carries the full
rationale.

Two clients drive it: `tools/cfx.mjs` (a CLI — `info`, `status`, `ls`, `get`, `cmd`, plus
`--trace` for the raw message log) and the web app's **Device** view, which adds live status
polling, a file browser, action buttons and a console of decoded traffic. The optional `usb`
dependency is needed only by the CLI.

Not implemented: file **upload** (`CRCSENDFILE` and the §5 GUID sequence), run control
(`RemoteRun`/`PROCEED`), and protocol authoring — this client reads an instrument and retrieves
files from it; it does not start runs. §6's gap is unchanged and unaffected.
