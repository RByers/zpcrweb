# `cfx.mjs`

Talk to a live CFX96 / C1000 Touch over USB from the command line: identification, status,
directory listing and file download.

This is the Node face of the same `@zpcrweb/core` USB client the web app's Instrument view drives
in the browser — see [`usb.md`](../docs/usb.md) and `packages/core/src/usb/transport.ts` for why there
is only one implementation. The only thing this file supplies that the browser doesn't is the
device handle: node-usb's `WebUSB` in place of `navigator.usb`. Everything after that line is
shared.

## Usage

```sh
node tools/cfx.mjs info                       # identification block
node tools/cfx.mjs status                     # STATUS? / RTSTATUS?, decoded
node tools/cfx.mjs ls                         # the well-known directories
node tools/cfx.mjs ls '\Storage Card\CurrentRun'
node tools/cfx.mjs get '\Storage Card\CurrentRun\Read00001.Plateread' -o read1.Plateread
```

`info` is the default when no subcommand is given.

`--trace` (accepted anywhere on the command line) prints every framed message in both directions —
the CLI equivalent of the Instrument view's debug console. Trace output goes to stderr, so it stays
out of a redirected download.

## No escape hatch

There is no "send an arbitrary command line" subcommand. `CfxDevice` exposes named operations only,
so every subcommand here is one of those. Reaching a command the library doesn't implement means
implementing it there, where its reply gets parsed and its provenance recorded in `usb.md` §3.

## Requirements

The optional `usb` dependency (`npm install` pulls it in; it ships prebuilt binaries) and a built
core (`npm run build`). The script exits with a clear message if `usb` is missing or if no Bio-Rad
instrument (vendor `0x0614`) is on the bus.
