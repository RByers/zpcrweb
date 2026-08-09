# `usbpcap_decode.py`

Decodes a USBPcap-format `.pcapng` capture of CFX96 instrument traffic. A standalone analysis tool
for validating [`usb.md`](../docs/usb.md) against a real capture — not part of the built app, and the
one tool here that is Python rather than Node.

## Usage

```sh
python3 tools/usbpcap_decode.py <file.pcapng>              # what devices are in this capture?
python3 tools/usbpcap_decode.py <file.pcapng> --device 3   # decode one device's stream
python3 tools/usbpcap_decode.py <file.pcapng> --device 3 --raw
```

With no `--device`, it prints one line per USB device number seen, the VID:PID identified from any
captured `GET_DESCRIPTOR(DEVICE)` completion, and packet counts — enough to find which device
number is the CFX96 in a given capture (look for VID `0x0614`).

With `--device N`, it prints the decoded command/response stream for that device: channel-1 ASCII
RCI exchanges rendered as text. `--raw` widens that to the traffic normally left out — non-channel-1
messages and control transfers — as one-line summaries.

## What it decodes

Two nested headers, which is worth keeping straight when reading the code:

- **USBPcap's own capture header** — the public outer envelope every frame in the capture has
  (27 bytes; see desowin.org/usbpcap/captureformat.html). dpkt doesn't know this format, so it is
  unpacked by hand here.
- **The CFX96 application-layer header** — the 5-byte header documented in `usb.md`, which sits
  inside the payload of BULK frames.

`usb.md` is the authority for the layout and field meanings this script implements; when one
changes, change both.

## Requirements

Python 3 and `pip install dpkt` (used for pcapng framing only).
