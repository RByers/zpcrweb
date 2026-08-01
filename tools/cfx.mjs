#!/usr/bin/env node
/**
 * Talk to a CFX96 / C1000 Touch over USB from the command line.
 *
 * This is the Node face of the same `@zpcrweb/core` USB client the web app's Device view drives
 * in the browser — see `packages/core/src/usb/transport.ts` for why there's only one
 * implementation. The only thing this file supplies that the browser doesn't is the device
 * handle: node-usb's `WebUSB` in place of `navigator.usb`. Everything after that line is shared.
 *
 * Needs the optional `usb` dependency (`npm i` installs it; it ships prebuilt binaries) and a
 * built core (`npm run build`).
 *
 *   node tools/cfx.mjs info                       # identification block
 *   node tools/cfx.mjs status                     # STATUS? / RTSTATUS?, decoded
 *   node tools/cfx.mjs ls                         # the well-known directories
 *   node tools/cfx.mjs ls '\Storage Card\CurrentRun'
 *   node tools/cfx.mjs get '\Storage Card\CurrentRun\Read00001.Plateread' -o read1.Plateread
 *
 * `--trace` prints every framed message in both directions, which is the CLI equivalent of the
 * Device view's debug console.
 *
 * There is no "send an arbitrary command line" subcommand: `CfxDevice` exposes named operations
 * only (see its design point 3), so every subcommand here is one of those. Reaching a command the
 * library doesn't implement means implementing it there, where its reply gets parsed and its
 * provenance recorded in `usb.md` §3.
 */
import { writeFile } from "node:fs/promises";
import { CFX_DIRECTORIES, CFX_USB_FILTER, CfxDevice } from "../packages/core/dist/index.js";

const argv = process.argv.slice(2);
const trace = argv.includes("--trace");
const args = argv.filter((a) => a !== "--trace");
const [cmd = "info", ...rest] = args;

const hex = (b) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(" ");

function traceEvent(e) {
  const arrow = e.direction === "out" ? "→" : "←";
  const tag = `ch${e.channel}${e.unsolicited ? " (unsolicited)" : ""}`;
  const body = e.text !== null ? JSON.stringify(e.text.replace(/\r?\n$/, "")) : hex(e.payload);
  console.error(`  ${arrow} ${tag.padEnd(18)} ${body.slice(0, 300)}`);
}

async function connect() {
  let WebUSB;
  try {
    ({ WebUSB } = await import("usb"));
  } catch {
    console.error("The optional `usb` package isn't installed. Run `npm install`.");
    process.exit(1);
  }
  const usb = new WebUSB({ allowAllDevices: true });
  const devices = await usb.getDevices();
  const found = devices.find((d) => d.vendorId === CFX_USB_FILTER.vendorId);
  if (!found) {
    console.error("No Bio-Rad instrument found on USB (looking for vendor 0x0614).");
    process.exit(1);
  }
  const device = new CfxDevice(found, { onTraffic: trace ? traceEvent : undefined });
  await device.open();
  return device;
}

const fmtBytes = (n) =>
  n == null ? "—" : n > 1e9 ? `${(n / 1e9).toFixed(2)} GB` : `${(n / 1e6).toFixed(1)} MB`;

function table(rows) {
  const w = Math.max(...rows.map(([k]) => k.length));
  for (const [k, v] of rows) if (v !== undefined && v !== "") console.log(`  ${k.padEnd(w)}  ${v}`);
}

const device = await connect();
try {
  switch (cmd) {
    case "info": {
      const i = await device.deviceInfo();
      console.log("Instrument");
      table([
        ["Model", `${i.manufacturer} ${i.model}`],
        ["Serial", i.serial],
        ["Firmware", i.firmware],
        ["Front-end software", i.frontEndSoftware],
        ["Block", `${i.blockDescription ?? "?"} (id ${i.alphaId ?? "?"}, ×${i.blockCount ?? "?"})`],
        ["Optical head serial", i.alphaSerial],
        ["CPLD", i.cpld],
        ["Reaction volume", i.volumeUl != null ? `${i.volumeUl} µL` : undefined],
        ["Lid", `force ${i.lidForce}, version ${i.lidVersion}/${i.lidBVersion}`],
        ["Free storage", fmtBytes(i.freeSpaceBytes)],
        ["RAM", fmtBytes(i.totalRamBytes)],
        ["Errors", String(i.errorCount ?? "?")],
        ["Lockdown", i.superLockdown],
      ]);
      break;
    }
    case "status": {
      const s = await device.status();
      console.log("Status");
      table([
        ["State", s.running ? `RUNNING — ${s.stepText}` : s.stepText || "IDLE"],
        ["Block", s.blockTempC != null ? `${s.blockTempC.toFixed(2)} °C` : "—"],
        ["Sample (inferred)", s.sampleTempC != null ? `${s.sampleTempC.toFixed(2)} °C` : "—"],
        ["Lid heater", s.lidTempC != null ? `${s.lidTempC.toFixed(1)} °C` : "—"],
        ["Lid", s.lid],
        ["Cycle / step", `${s.cycle ?? "—"} / ${s.step ?? "—"}`],
        ["Run name", s.runName || "(none)"],
        ["Method", s.method],
        ["Real-time", s.realTime == null ? "—" : s.realTime ? "ON" : "OFF"],
      ]);
      const errors = await device.errorList();
      console.log(`  Errors            ${errors.length ? errors.join(", ") : "none"}`);
      console.log(`\n  raw STATUS?   ${s.raw}`);
      console.log(`  raw RTSTATUS? ${(await device.rtStatus()).raw}`);
      break;
    }
    case "ls": {
      const dirs = rest.length ? rest.map((path) => ({ path, label: path })) : [...CFX_DIRECTORIES];
      for (const d of dirs) {
        const { names, listingBytes, listed, status } = await device.listFiles(d.path);
        if (status === "empty") {
          console.log(`\n${d.path}  — no files (subdirectories aren't listed)`);
          continue;
        }
        if (!listed) {
          const why =
            status === "missing" ? "no such directory" : "GETFILESLEN gave an unrecognized reply";
          console.log(`\n${d.path}  — cannot be listed (${why})`);
          continue;
        }
        console.log(`\n${d.path}  — ${names.length} file(s), listing ${listingBytes} bytes`);
        for (const f of names) console.log(`  ${f}`);
      }
      break;
    }
    case "get": {
      const path = rest[0];
      if (!path) throw new Error("usage: get <device path> [-o <output file>]");
      const oi = rest.indexOf("-o");
      const out = oi >= 0 ? rest[oi + 1] : path.split("\\").pop();
      const bytes = await device.getFile(path);
      await writeFile(out, bytes);
      console.log(`${path} → ${out} (${bytes.length} bytes)`);
      break;
    }
    default:
      console.error(`unknown command: ${cmd}`);
      process.exitCode = 1;
  }
} finally {
  await device.close();
}
process.exit(process.exitCode ?? 0);
