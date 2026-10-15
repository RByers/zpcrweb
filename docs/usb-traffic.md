# `usb-traffic.bin` — the recorded USB traffic log

## 1. What this is for

When the app drives a run over USB (`usb.md`), the one thing that explains a run that went wrong is
what actually crossed the wire: the command that was refused, the reply that arrived on the wrong
channel, the transfer that had to be retried. So the Instrument view records all of it, always, and
a run's `.zpcr` can carry that record alongside the instrument's own files.

The obvious way to store it is the way you read it — one formatted line per message:

```
2026-08-02T12:00:00.000Z -> ch1 [8B] 53 54 41 54 55 53 3f 0a text="STATUS?"
```

That line is 85 bytes, of which the payload is 8. The rest is a re-printed ISO timestamp, a hex
expansion at three characters per byte, and the same handful of words every time. It is also
relentless: the status poll alone is six messages every 1.5 s (`usb/session.ts`'s `POLL_MS`), so an
hour is 14 400 messages and 1.3 MB before anything interesting has happened, held in browser memory
for the whole session and then written into the run's file.

So the log is **stored as records and rendered as text on demand**. The bytes as framed, plus the
three facts about a message that can't be recovered from them, are what goes on disk; the line
above is what `formatUsbTrafficLog` builds when someone looks at it. §5 measures what that buys:
**5.4× smaller stored, and 40× smaller once the `.zpcr`'s deflate has had it** — an hour of polling
is 1 KB inside the archive, against 41 KB for the same hour as text.

Implemented by `packages/core/src/usbTraffic.ts`, which is the format's only reader and writer:
`UsbTrafficRecorder` appends, `parseUsbTrafficLog` reads back, `formatUsbTrafficLog` renders. Not
reverse-engineered — this is our own format, so every rule below is *this library's own*.

> **Note:** `.zpcr` files written before this format carry a plain-text `usb-traffic.log` entry
> instead. Both names are recognized (`isUsbTrafficName`) and the Raw files view reads either; only
> `usb-traffic.bin` is ever written — and only `usb-traffic.bin` is ever downloaded (§4).

## 2. What is stored, and what is derived

Three things about a message are **not** in its payload bytes, so each gets a flag bit:

| Fact | Why it can't be derived |
|------|-------------------------|
| `unsolicited` | An unsolicited channel-1 message and a reply to a command look identical on the wire (`usb.md` §2). Only the client, which knows what it asked for, can tell them apart. |
| `poll` | Whether a line is status-poll chatter. A reply carries no copy of its request, so it is classified on arrival against the message before it (`usb/session.ts`'s poll classifier). |
| *binary* | Whether the device offered a text decode at all. A `passThrough` reply is left as bytes even when every one of them is printable, so re-testing the payload would invent a decode the client never had. |

Everything else is derived at format time: the direction arrow from the direction bit, the byte
count from the payload length, the text from the payload (`usbTrafficText`, latin1, "every byte
printable or not" — the same test `CfxDevice.asText` applies), and the timestamp from the running
delta.

## 3. The format

A file is the 8-byte magic `ZUSBLOG1` followed by a sequence of **items**, each opening with a type
byte. There is no count, no index and no trailer: a log is written incrementally by a session that
may end at any moment, and a reader stops when the bytes do.

| Type | Item | Payload |
|------|------|---------|
| `0x01` | segment | `u48` base timestamp (epoch ms, little-endian) |
| `0x02` | message | `u8` flags, `varint` Δt, `u8` channel, `varint` length, *length* payload bytes |
| `0x03` | error | `u8` flags, `varint` Δt, `varint` attempt, `varint` length, *length* UTF-8 bytes |
| `0x04` | gap | `varint` records dropped |

### 3.1 Integers

`varint` is LEB128: 7 bits per byte, low group first, high bit set on every byte but the last. Δt
is the milliseconds since the previous item in the same segment (0 for the first), so an idle poll
costs two bytes for its timestamp instead of a re-printed 24-character date. Deltas are **clamped
at zero**: `Date.now()` can step backwards under a clock adjustment, and a log that stays readable
through one is worth more than a log that records it.

`u48` is a 6-byte little-endian unsigned integer — epoch milliseconds until the year 10889, and
three bytes cheaper than the 64-bit field it replaces.

### 3.2 Flags

| Bit | Message | Error |
|-----|---------|-------|
| 0 | direction: 0 = out, 1 = in | same |
| 1 | unsolicited | — |
| 2 | poll chatter | — |
| 3 | payload was *not* offered as text (§2) | — |
| 4 | — | fatal (the failure ended something) |

### 3.3 Segments, and why the timestamps restart

A segment is just a base timestamp; every item after it counts from there. They exist so the
recorder can enforce a **memory budget** without rewriting anything: deltas mean a stream can only
be read from its start, so dropping the oldest records out of one stream would mean re-encoding all
of it. Instead the recorder closes the current segment every 256 KB and opens another, and the
oldest *segment* can simply be dropped — every remaining one is self-contained, and the file is
their concatenation behind one header.

A dropped segment leaves a **gap** item in its place (written just after the magic), so a reader
sees that records are missing rather than a suspiciously quiet hour. The default budget is 24 MB,
about a day of idle polling; the app never expects to reach it, and it exists so an instrument left
connected overnight can't grow without bound.

## 4. The text rendering

`formatUsbTrafficLog(records)` is the only text form there is — the console shows it live and the
Raw files view renders the archived copy with it, so what a reader sees on screen is the same in
both places. It is **a rendering, never a file**: every download of a log — the console's button on
a live session, the same button over a run's saved log, and the Raw files view's — writes the
records themselves as `usb-traffic.bin`, because the rendering below previews a long response
rather than spelling it out, and a log that has dropped the body of a `GETFILE` reply can't answer
"was this transfer corrupt?", which is the question a traffic log exists for. Reading a downloaded
log means loading it back: a `.zpcr` that carries it opens in the Raw files view, explained (§6),
with this rendering one click away as its Text mode. One line per record, in wire order:

```
<iso> -> ch<n> [<len>B] <hex>[ text="…"]      a message (-> out, <- in)
<iso> <- ch<n> (unsolicited) [<len>B] <hex>   … and its unsolicited flag
<iso> !! transfer error (in, attempt 3, fatal): <message>
!! <n> earlier records dropped (recording buffer full)
```

A message line **always** carries `[<n>B] <hex>`, even when it also shows `text=…`. The decode is a
best-effort guess (§2) and a trailing `\r`/`\n` is trimmed from it; for a payload this log exists to
help *decode*, the bytes are the ground truth and the text is a convenience beside them.

A **response** (`direction: "in"`) longer than 16 bytes has its `hex` and `text` previewed instead
of spelled out in full: the first 16 bytes or characters, then `… (+n more elided)`. This is a
rendering choice only — the byte count at the front of the line still says how much there really
was, and the archived record keeps every byte regardless of what this rendering shows. It exists
because a `GETFILE` reply is tens of kilobytes, and printing all of it as hex would turn "one line
per record" into one line as long as the payload — unreadable in exactly the case (a big transfer)
where the log is most worth reading. Sixteen is one hexdump line: enough to recognise a payload by
its opening bytes, which is all this rendering is for. Requests aren't elided: everything the
client sends is a short command, so the cutoff only ever applies to the replies it targets.

The cut lives in `usbTrafficPreview(msg)`, exported alongside the constant, because there are two
renderings of the same traffic and they must agree: this one, and the app's **live console**, which
builds its lines as messages arrive rather than from stored records
(`packages/core/src/usb/session.ts`). Eliding at that end also keeps a fetched file's bytes out of
React state, where a few transfers would otherwise sit in the display buffer as megabytes of hex
nobody can read.

`packages/core/test/usbTraffic.test.ts` pins the round trip against this rendering rather than
against field equality: what a session records and what a reader sees must be the same log, line
for line, or the compaction has traded away the thing it exists to preserve.

## 5. What it costs

Measured on the status poll — three queries and three replies every 1.5 s, which is what a log is
overwhelmingly made of — with `deflateSync` standing in for the `.zpcr`'s own compression:

| Session | Records | As text | text, zipped | As records | **records, zipped** |
|---------|--------:|--------:|-------------:|-----------:|--------------------:|
| 1 hour | 14 400 | 1 284 KB | 41 KB | 237 KB | **1 KB** |
| 3 hours | 43 200 | 3 853 KB | 123 KB | 710 KB | **3 KB** |
| 12 hours | 172 800 | 15 413 KB | 491 KB | 2 841 KB | **10 KB** |

Two separate wins, and the second is the bigger one. Stored, a record is ~16 bytes against an
~85-byte line — 5.4×. Compressed, the gap widens to ~40×, because the text's per-line ISO timestamp
is 24 characters that change every time, while the records spend two bytes on the same fact and
leave long stretches of near-identical binary for deflate to collapse.

The practical reading: **attaching the log to a run costs single-digit KB**, on a `.zpcr` that is
already hundreds. That is what makes "save log" a switch worth offering rather than a warning worth
printing.

## 6. The decoded view

§4's rendering answers "what crossed the wire". It doesn't answer what a person reading a log
actually asks: which request did this reply answer, what do the twenty numbers of a `STATUS?` mean,
did that upload arrive intact, what bytes is this file made of. The Raw files view's **Decoded**
mode does, and it is now where `usb-traffic.bin` opens. Implemented by
`packages/core/src/usbTrafficDecode.ts` (`decodeUsbTrafficLog`); the app's
`components/raw/DecodedUsbTraffic.tsx` only lays it out.

It works in two layers, both pure functions of the file's bytes.

**Layout — every byte accounted for.** The file is walked item by item, and each item is broken into
the §3 fields at their own offsets: the type byte, the flag bits named one by one, the Δt varint
and the absolute time it yields, the channel, the length varint, the payload. The 8-byte magic and
each segment are items too, so the rows tile the whole file with no gap or overlap — the test pins
that, and pins the walk to `parseUsbTrafficLog`'s records. The walk is separate from the format's
reader for one reason: it **never throws**. A file cut short or not a log at all decodes as far as
it reads, and the remainder becomes one *undecodable* item holding the bytes that were left, because
a raw view shows what a file holds, damaged or not.

**Meaning — the payload read as the protocol** (`usb.md`). Channel-1 requests are matched to replies
the way `CfxDevice.dispatch` matches them, since the wire carries no request ids:

| Rule | Why |
|------|-----|
| A reply answers the **oldest request still waiting** | `dispatch`'s FIFO queue |
| An unsolicited reply answers nothing | the `unsolicited` flag (§2) is the device's own verdict that nobody was waiting |
| A fatal **out** error retracts the request just sent | `exchangeBytes` drops a request whose write failed |
| A `GETFILE` stays waiting while full 65,530-byte parts arrive | a large file comes back in parts (`usb.md` §5) |

Then each payload is read with the parsers the live client uses — `parseResponse`, `parseStatus`,
`parseRtStatus`, `parseIdentity`, `parseRunDefinition`, `cfxFileCrc` — so there is one reading of the
protocol, not a second one kept in step by hand. Beyond naming fields, three things are **checked**,
because they are the questions a log exists to answer: a `GETFILE` reply's size against the
`GETFILESIZE` before it; a `CRCSENDFILE`'s announced checksum against its own file bytes; and the
`GETFILECRC` the instrument later reports against the checksum announced for that upload (followed
through the generated name `COMPUTEFILECRC` returned). Each command also carries a one-sentence
description of what it does, from `usb.md` §3's vocabulary.

Status polls are most of any log (10 336 of the 10 780 messages in the one committed sample) and can
be hidden, but are shown by default: this is a raw view. The download button saves the stored
`.bin` from this mode too, as from Text (§4).

> **Future:** a request that **timed out** leaves no item — `CfxDevice` drops it from its queue
> without telling the recorder — so here it stays waiting. A late reply is then paired with it
> (which is probably what it really answers, though not how the client paired it), and if no reply
> ever comes, every pairing after it is one request off. Recording timeouts as their own item would
> close this.

## 7. Future

- **Recording timeouts** — §6's note: a timed-out request leaves no item, so pairing after one
  can drift.
- **Payload truncation.** A run's `GETFILE` transfers dominate a real log — a plate read is ~50 KB,
  fetched repeatedly by the run watcher — and their content is already in the `.zpcr` beside the
  log. Storing the first *n* bytes plus the true length would shrink a real recording much further
  than any of §5's numbers suggest. Deliberately not implemented: a truncated payload can't answer
  "was this transfer corrupt?", which is exactly the question a traffic log exists for.
- **Recording across a reload.** The recorder lives in memory, so a reload starts a new log. The
  records are small enough to persist in IndexedDB; nothing needs it yet.
