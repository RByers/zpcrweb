#!/usr/bin/env python3
"""Decode a USBPcap-format .pcapng capture of CFX96 instrument traffic.

Not part of the built app — a standalone analysis tool for validating usb.md
against a real capture. Requires `pip install dpkt` (pcapng framing only; the
USBPcap packet header below is decoded by hand, since dpkt doesn't know it).

Usage:
    python3 tools/usbpcap_decode.py <file.pcapng> [--device N] [--raw]

With no --device, prints one line per USB device number seen, its identified
VID:PID (from any captured GET_DESCRIPTOR(DEVICE) completion), and packet
counts — enough to find which device number is the CFX96 in a given capture
(look for VID 0x0614). Pass --device N to print the decoded command/response
stream for that device: channel-1 (ASCII RCI) exchanges rendered as text,
everything else as a one-line summary. See usb.md for the header layout and
field meanings this script implements.
"""
import argparse
import struct
import sys
from collections import Counter, defaultdict

import dpkt.pcapng as pcapng

USBPCAP_LINKTYPE = 249

TRANSFER_NAMES = {0: "ISOCHRONOUS", 1: "INTERRUPT", 2: "CONTROL", 3: "BULK"}
STAGE_NAMES = {0: "SETUP", 1: "DATA", 2: "STATUS", 3: "COMPLETE"}

# USBPcap's own capture header (public format — see desowin.org/usbpcap/captureformat.html),
# NOT the CFX96 application-layer header. This is the outer envelope every frame in the
# capture has; the CFX96 5-byte header (see usb.md) is inside the payload of BULK frames.
USBPCAP_HDR = struct.Struct("<HQIHBHHBBI")  # 27 bytes


class Urb:
    __slots__ = ("ts", "irp_id", "status", "function", "bus", "device", "ep_num",
                 "direction", "transfer", "transfer_name", "data_length", "stage", "payload")


def parse_frame(ts, buf):
    (header_len, irp_id, status, function, info, bus, device, endpoint, transfer,
     data_length) = USBPCAP_HDR.unpack_from(buf, 0)
    u = Urb()
    u.ts, u.irp_id, u.status, u.function = ts, irp_id, status, function
    u.bus, u.device = bus, device
    u.ep_num = endpoint & 0x7F
    u.direction = "IN" if (endpoint & 0x80) else "OUT"
    u.transfer = transfer
    u.transfer_name = TRANSFER_NAMES.get(transfer, f"0x{transfer:02x}")
    u.stage = STAGE_NAMES.get(buf[27]) if transfer == 2 and header_len >= 28 else None
    u.data_length = data_length
    u.payload = buf[header_len:header_len + data_length]
    return u


def iter_urbs(path):
    with open(path, "rb") as f:
        r = pcapng.Reader(f)
        if r.datalink() != USBPCAP_LINKTYPE:
            raise SystemExit(f"expected USBPcap linktype {USBPCAP_LINKTYPE}, got {r.datalink()}")
        for ts, buf in r:
            yield parse_frame(ts, buf)


# --- CFX96 application-layer header (see usb.md §2) ---

def decode_cfx_header(payload):
    """Decode the 5-byte application-layer header prefixing a logical message.
    Only present on the first USB-level packet of a message that spans several
    (large transfers get split into consecutive same-direction bulk packets with
    no header of their own — reassembly is the caller's job)."""
    if len(payload) < 5:
        return None
    b0, b1, b2 = payload[0], payload[1], payload[2]
    length = struct.unpack(">H", payload[3:5])[0]
    return dict(
        handle=b0 >> 2, channel=b0 & 0x3,
        newline=(b1 >> 6) & 1, chartimeout=(b1 >> 3) & 7, msgtimeout=b1 & 7,
        ascii=(b2 >> 3) & 1, textpayload=(b2 >> 2) & 1, passthrough=(b2 >> 1) & 1,
        dummy=b2 & 1, length=length, body=payload[5:5 + length],
        body_complete=len(payload) >= 5 + length,
    )


def summarize_devices(path):
    counts = Counter()
    vidpid = defaultdict(set)
    for u in iter_urbs(path):
        counts[u.device] += 1
        if u.transfer == 2 and u.stage == "COMPLETE" and len(u.payload) >= 18 and u.payload[1] == 1:
            vid, pid = struct.unpack_from("<HH", u.payload, 8)
            vidpid[u.device].add((vid, pid))
    for dev in sorted(counts):
        ids = ", ".join(f"{v:#06x}:{p:#06x}" for v, p in sorted(vidpid.get(dev, [])))
        flag = "  <-- CFX96/C1000" if any(v == 0x0614 for v, p in vidpid.get(dev, [])) else ""
        print(f"device #{dev}: {counts[dev]:6d} packets  VID:PID seen = {ids or '(none captured)'}{flag}")


def _emit(i, ts, direction, m, raw):
    body = bytes(m["body"])
    if m["channel"] == 1:
        try:
            text = body.decode("ascii", errors="replace").rstrip("\r\n")
        except Exception:
            text = body.hex()
        print(f"{i:6d} {ts:.6f} ch{m['channel']} {direction:3s} {text}")
    elif raw:
        print(f"{i:6d} {ts:.6f} ch{m['channel']} {direction:3s} "
              f"pt={m['passthrough']} {body.hex()}")


def dump_device(path, device, raw):
    """Reassemble each direction's bulk stream into logical messages before
    printing anything. A message's 5-byte header (see usb.md §2) appears only
    on the packet that starts it; every packet before that message's `length`
    payload bytes have arrived is a headerless continuation. Earlier versions
    of this function re-ran decode_cfx_header on every packet independently —
    which mostly worked, but occasionally mistook raw continuation bytes of a
    large transfer (e.g. a GETFILE download) for a fresh header when those
    bytes happened to look like one, fabricating short spurious messages on
    channels that were never really used. Tracking `pending`/`remaining` per
    direction, as done here, removes that ambiguity."""
    pending = {"IN": None, "OUT": None}  # dict with handle/channel/length/body/start_i/start_ts, or None
    remaining = {"IN": 0, "OUT": 0}

    for i, u in enumerate(iter_urbs(path)):
        if u.device != device:
            continue
        if u.transfer == 3 and u.data_length > 0:  # BULK
            d = u.direction
            if remaining[d] == 0:
                h = decode_cfx_header(u.payload)
                if h is None:
                    if raw:
                        print(f"{i:6d} {u.ts:.6f} BULK {d:3s} short packet (< 5 bytes), "
                              f"can't hold a header: {u.payload.hex()}")
                    continue
                pending[d] = dict(handle=h["handle"], channel=h["channel"], length=h["length"],
                                   passthrough=h["passthrough"], body=bytearray(h["body"]),
                                   start_i=i, start_ts=u.ts)
                remaining[d] = h["length"] - len(h["body"])
            else:
                pending[d]["body"].extend(u.payload)
                remaining[d] -= len(u.payload)

            if remaining[d] <= 0:
                m = pending[d]
                _emit(m["start_i"], m["start_ts"], d, m, raw)
                pending[d] = None
                remaining[d] = 0
        elif raw and u.transfer == 2 and u.stage == "SETUP" and len(u.payload) == 8:
            bmReq, bReq, wVal, wIdx, wLen = struct.unpack("<BBHHH", u.payload)
            print(f"{i:6d} {u.ts:.6f} CONTROL SETUP bmRequestType={bmReq:#04x} "
                  f"bRequest={bReq:#04x} wValue={wVal:#06x} wIndex={wIdx:#06x} wLength={wLen}")

    for d in ("IN", "OUT"):
        if pending[d] is not None and raw:
            m = pending[d]
            print(f"{m['start_i']:6d} {m['start_ts']:.6f} BULK {d:3s} truncated: capture ended "
                  f"{remaining[d]} bytes short of the declared length={m['length']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("pcapng")
    ap.add_argument("--device", type=int, default=None)
    ap.add_argument("--raw", action="store_true", help="also show channel!=1 and control traffic")
    args = ap.parse_args()
    if args.device is None:
        summarize_devices(args.pcapng)
    else:
        dump_device(args.pcapng, args.device, args.raw)
