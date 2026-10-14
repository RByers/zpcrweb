# `emucheck.mjs`

Replays a USBPcap capture of CFX Manager driving a real CFX96 at the emulator, and reports every
command the instrument answered that the emulator answers differently — and every one it does not
implement at all. This is [`emulator.md`](../docs/emulator.md) §10.2, the by-hand half of the
emulator's validation; its output is what populates that document's Appendix A.

## Usage

```sh
npm run build -w @zpcrweb/core                        # it imports the built core
node tools/emucheck.mjs ~/lab/BioRad/CFX-usb-basic.pcapng
node tools/emucheck.mjs ~/lab/BioRad/CFX-usb-run.pcapng --all
```

| Option | Meaning |
|---|---|
| `--device N` | the capture's USB device number for the instrument; found automatically from the VID when omitted |
| `--data <run.zpcr>` | the recording whose curves the emulated run replays into every well (default: the committed YouSeq RT run) |
| `--all` | every differing exchange, not just the first per verb and kind |
| `--python <exe>` | the Python 3 that has `dpkt` installed (default `python3`) |

Exit status is 1 when something drifted — a result code or reply shape the instrument gave
differently, a command left unanswered, or the run's `STATUS?` edges in a different order — and 0
when every difference is a value the instrument alone decides (temperatures, clocks, free space,
a GUID).

## What it reports

A per-verb table — how many exchanges, and how many were `exact`, differed in `value`, `code`,
`shape` or `bytes`, or went unanswered — then the differences grouped by what they mean:

- **REJECTED by the emulator, accepted by the instrument** — a command the emulator does not
  implement, or is stricter about than the real thing.
- **ACCEPTED by the emulator, rejected by the instrument** — the emulator is *more permissive*
  here, which is the one failure Appendix A says must never stand.
- `SHAPE`, `BYTES`, `VALUE` differences, the last annotated when the difference is expected.
- Which `STATUS?` fields each side ever populated.
- **The run's edges, side by side**: every change of step, cycle, descriptor or register, at the
  capture second it happened and with the run's own elapsed clock — the sequence the follower keys
  on, and the one place a timing model shows its error in seconds.

## Requirements

A built core (`packages/core/dist`), and Python 3 with `dpkt` for
[`usbpcap_decode.py`](./usbpcap_decode.md), which this script runs with `--jsonl` to get every
message losslessly (the decoder's text form replaces the bytes of a downloaded file). The captures
are the operator's and live outside the repository, which is why this is run by hand rather than
by `npm test`; `emulatorFidelity.test.ts` does the in-repo equivalent against the one committed
traffic log.

## Design notes

- **Seeding.** The emulator starts with what the capture shows the instrument holding when it
  began: the first listing of each directory, the sizes `GETFILESIZE` reported, and the bytes of
  any file the capture downloaded whole. Anything the capture creates later — an upload, a run's
  reads, its report — is left for the emulator to produce, since producing it is what is being
  checked.
- **Time.** The emulator runs on a manual clock advanced to each command's capture timestamp, so
  its run and the real one are polled at the same instants; the edge table's left and right
  columns are therefore directly comparable.
- **GUIDs.** The capture's `COMPUTEFILECRC` replies name staging GUIDs the emulator mints
  differently; each is mapped onto the emulator's as it appears so later commands reach the file.
- **Split downloads.** A `GETFILE` longer than 65,530 bytes arrives as several messages
  (`usb.md` §5); the reply is reassembled to the size the preceding `GETFILESIZE` announced
  before comparing.
- **Pairing** is "the next channel-1 message inbound". The captures are a single-client
  conversation and that holds throughout, with one exception the report shows as an `*IDN?`
  answered `0000` and another answered with four raw bytes: the instrument's replies ran one
  behind for two commands after a `TESTMODE 3` — a capture artefact, not an emulator behaviour.
