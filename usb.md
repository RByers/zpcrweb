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
`tools/usbpcap_decode.py` (§8) against the raw pcapng bytes — every field and byte offset below
was checked against the actual capture, not assumed.

## 1. Device identity and topology

The instrument enumerates as a single USB device (not a hub with sub-devices) with:

| Field | Value |
|---|---|
| idVendor | `0x0614` (Bio-Rad) |
| idProduct | `0x057B` (C1000 Touch Thermal Cycler) |
| bDeviceClass/SubClass/Protocol | `0xEF/0x02/0x01` (IAD — misc. composite marker; harmless, there's only one function) |
| bMaxPacketSize0 | 64 |

Other Bio-Rad PIDs likely share this same family (C1000 non-touch, CFX Connect, S1000) but weren't
captured here, so their exact values aren't confirmed by this document. A device presenting
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

> **Caveat on the config descriptor.** Neither capture shows the host fetching this descriptor
> for the CFX96 device itself — only for two unrelated peripherals on the same root hub (a
> Bluetooth radio and a webcam). The interface/endpoint table above comes from a
> `GET_DESCRIPTOR(CONFIGURATION)` that *is* present at the very start of `usb-run` for a device
> that is already `0x0614:0x057B` — so the values are measured, just from `usb-run` rather than
> `usb-basic`. The query for it simply isn't inside `usb-basic`'s capture window; only the
> endpoints' *use* is confirmed in both.

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

This layout was derived directly from the capture: every channel-1 message in both files (over a
thousand of them) decodes cleanly against it, with the announced length always matching the
trailing ASCII payload exactly. Example, byte-exact from `usb-basic` (a `*IDN?` query):

```
01 7f 0c 00 07  2a 49 44 4e 3f 0d 0a
```
`handle=0, channel=1` · `newLine=1, charTimeout=7, msgTimeout=7` · `ascii=1, textPayload=1,
passThrough=0, dummyAdded=0` · length=`0x0007=7` · payload = `"*IDN?\r\n"`. The `msgTimeout=7,
charTimeout=7` pair is constant — the same 7/7 values show up in **every** channel-1 message
across both captures, so it's evidently a fixed value this protocol always uses, not something
that needs to vary.

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

**Channels.** The `channel` field (2 bits, so 0–3) multiplexes independent logical streams over
the same pair of bulk endpoints:

| Channel | Use | Evidence |
|---|---|---|
| 1 | ASCII command/response (§3) — the vast majority of traffic in both captures | every message decodes as a printable ASCII command line, CR-terminated |
| 2 | A binary auxiliary stream, still only partially decoded (§4) | short fixed-format binary requests/responses, high frequency during lid/LED-adjacent polling |
| 0 | Rare — a handful of short messages per capture | not characterized; too little traffic to reverse |

`handle` was **always 0** across every message in both captures — either this instrument only ever
hands out handle 0, or CFX Manager never had cause to open a second one in the traffic captured.
Don't assume it's always 0 without checking a capture that opens more than one logical session.

## 3. Channel 1 — the ASCII command language

A channel-1 message's payload is the literal command line: **ASCII, CR-terminated** for a request
(`\r\n` was used consistently in every message captured), no other structure — a plain text
command in, a plain text response out, framed per §2.

**Response shape.** A successful response is `<value>;<errcode>\r\n`, where `<errcode>` is a
decimal number, `0000` for success — e.g. `*IDN?` → `BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0;0000`.
For commands with no return value the `<value>` part is simply empty (`ERRORLIST A` →
`;0000`). This four-digit-error-code suffix is consistent across every response in both captures —
worth keeping in mind if a future capture ever shows a *non-zero* code, since neither capture here
triggered an actual device error.

Commands actually observed on the wire (this is not a complete command vocabulary — only what
appeared in these two captures):

| Command | Example response | Notes |
|---|---|---|
| `*IDN?` | `BIO-RAD LABORATORIES,C1000,CT019138,2.0.231.0;0000` | manufacturer, model, serial, firmware |
| `STATUS?` | `17.04;18.3;0;0;IDLE;0;"",BLOCK,OFF;0;0.00;0.00;0.00;0.00;0.00;0;0;0;17.04;CLOSED;0;0000` | polled every ~1s while idle; mid-run: `60.25;104.9;2;2;TEMP 95.0,10;2;"SINGLETE",CALC,ON;96;110.22;0000` — block temp, lid temp, cycle, step index, current step text, run name, method, lid state, block count, elapsed... |
| `RTSTATUS?` | `18.31;26;;0000` | shorter status, polled alongside `STATUS?` |
| `ERRORLIST A` | `;0000` | polled every cycle in lockstep with `STATUS?`/`RTSTATUS?` |
| `ALPHAID?` | `4;0000` | a block/head type identifier; this instrument (a CFX96) reports `4` — the general ID→name mapping wasn't derived from the capture, just this one observed value |
| `BLOCKCOUNT?`, `VOLUME?`, `WORKING?`, `BOOTMODE?`, `SELFTEST?`, `ENABLERT?` | — | queried once at the start of a run, not polled |
| `LID OPEN` | — | issued on physical lid-open; no response payload observed beyond `;0000` |
| `PROTOCOL '<name>'`, `METHOD <name>` | — | names the protocol/method being authored — see §5 |
| `HOTLID <temp>,<ramp>` | — | e.g. `HOTLID 105,30` |
| `VOLUME <µL>` | — | e.g. `VOLUME 25` |
| `TEMP <°C>,<seconds>` | — | one hold step, e.g. `TEMP 95.0,180` |
| `PLATEREAD #h<hex>` | — | e.g. `PLATEREAD #h3F` — hex mask, presumably channel/dye selection; not decoded bit-by-bit |
| `GOTO <step>,<count>` | — | e.g. `GOTO 2,1` — loop back to step 2, 1 more time (2 total passes) |
| `END` | — | closes the step list |
| `ADDCYCLES <n>` | — | |
| `RemoteRun "<A>","<B>","<C>","<name>","<user>","<pw?>","<D>","<method>"` | — | e.g. `RemoteRun "A","True","False","singletest","admin","","True","CALC"` — starts the authored protocol running under a given run name/user |
| `PROCEED` | — | resumes/confirms a run (there was a ~2-minute gap between `RemoteRun` and `PROCEED` in the capture — almost certainly the operator closing the lid and confirming on the touchscreen) |
| `CANCEL` | — | seen once, immediately after the first plate read was pulled — likely normal run-finished cleanup rather than a user abort, but not confirmed either way |
| `GETFILESLEN <dir>`, `LISTALLFILES <dir>`, `GETFILESIZE <path>`, `GETFILE <path>`, `DELFILE <path>` | — | filesystem access, §5 |
| `COMPUTEFILECRC "<path>"`, `GETFILECRC "<path>"` | `<crc>;0000` | upload verification, §5 |
| `CRCSENDFILE "<n>*<path>",<raw bytes>` | — | file upload, §5 — note this is the one command whose payload is *not* all-ASCII |
| `FRONTENDLOCKED OFF` | — | seen once, at the very end of the run capture |

## 4. Channel 2 — the binary auxiliary stream (partially understood)

Distinct from channel 1: same 5-byte header, `channel=2`, but the payload is a short fixed binary
structure instead of ASCII text. Example exchange (from `usb-basic`, during idle lid-position
polling):

```
OUT  02 05 0a 00 03  02 00 00
IN   02 00 00 00 06  04 00 00 04 0b 00
```

The request payload (`02 00 00`) and response payload (`04 00 00 04 0b 00`) look like a small
fixed-layout record, but **no byte-level field mapping is confirmed here** — the capture doesn't
give enough variation to pin down what each byte means. This channel carried a lot of short
traffic during idle polling in both captures (hundreds of frames), always ≤ 12 bytes payload, so
it's evidently some kind of frequent low-latency status/position register read rather than
anything related to the optical scan pipeline. **Nothing in either capture exercises the optical
head's scan protocol at all** — see §6.

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
CRCSENDFILE "<n>*<device path>",<raw file bytes>
```

e.g. `CRCSENDFILE "05672*\Storage Card\CurrentRun\QuickPlate_96 wells_All Channels.pltd",<1821
bytes of zip>` — the zip payload is byte-for-byte a complete, valid ZipCrypto container (local
file header, one entry, EOCD record present at the tail). **The `<n>*` prefix's meaning is not
confirmed** — in the two calls captured it was `05672` and `46850`, neither of which matches the
uploaded byte count (1821 and 1291 respectively), so it isn't a length field; likely some kind of
session/ticket identifier, but this is a guess, not a finding.

The observed upload sequence, per file (`GlobData.xml`, the `.pltd` plate map, `RunInfo.xml`, the
`.prcl` protocol), each following the same shape:

1. `DELFILE <friendly path>` — clear any stale file at the well-known name
2. `CRCSENDFILE "<n>*<friendly path>",<bytes>` — upload
3. `COMPUTEFILECRC "<friendly path>"` — device computes a CRC of what it has under that name
4. `GETFILESLEN`/`LISTALLFILES <dir>` — host re-lists the directory
5. `GETFILECRC "<dir>\<GUID>"` — host reads back a CRC for what turns out to be a **different,
   GUID-named file** in the same directory

Step 5's filename never matches step 1/2's — the device evidently stores the just-uploaded file
under a generated GUID name while `LISTALLFILES` is how the host discovers what that name turned
out to be, and it's that GUID name that gets CRC-verified. The rename-to-friendly-name step (if
any) wasn't isolated in this capture.

**Download** is simpler and doesn't have this indirection:

```
GETFILESIZE <path>          → "<byte count>;0000"
GETFILE <path>               → raw file bytes, length == the announced GETFILESIZE, as one
                                logical message chunked per §2 (4096-byte reads observed)
```

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
   and identify the unit.
3. Poll `STATUS?`/`RTSTATUS?`/`ERRORLIST A` (§3) — not strictly required, but this is what every
   real client does between commands and is a cheap liveness/error check.
4. Upload the plate map and protocol with `DELFILE`/`CRCSENDFILE`/`COMPUTEFILECRC` for each file
   (§5) — the well-known destination paths seen were under `\Storage Card\CurrentRun\`.
5. `RemoteRun "A","True","False","<name>","<user>","","True","<method>"`, then wait for the
   operator (or, for an unattended flow, whatever confirms lid closure) before `PROCEED`.
6. Poll `STATUS?` for step/cycle progress; each `PLATEREAD` step produces a new
   `Read0000N.Plateread` under `\Storage Card\CurrentRun\` — pull each with `GETFILESIZE` +
   `GETFILE` (§5) and decode with the existing `plateread.md`/`packages/core` parser.
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
python3 tools/usbpcap_decode.py capture.pcapng --device 3 --raw  # + channel 2, control transfers, continuation frames
```
