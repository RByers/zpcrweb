/**
 * Shared scaffolding for the two suites that drive a `CfxSession` against the emulator — kept out
 * of either test file so importing it doesn't re-register the other's cases.
 */
import { readFileSync } from "node:fs";
import { CfxSession, unzipArchive } from "../src/index.js";
import { recordedRunData, type CfxEmulator } from "../src/emulator.js";
import { RT_S56_SAMPLE_PATH } from "./sample.js";

let archive: Record<string, Uint8Array> | null = null;
export function pcrData() {
  if (!archive) {
    const buf = readFileSync(RT_S56_SAMPLE_PATH);
    archive = unzipArchive(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength));
  }
  return recordedRunData(archive);
}

/** Wait on a condition rather than on a duration — the same rule the browser harness follows. */
export async function waitFor(what: string, done: () => boolean, limitMs = 5_000): Promise<void> {
  const until = Date.now() + limitMs;
  while (!done()) {
    if (Date.now() > until) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

/** A session wired to one emulator, polling fast enough that a test never waits on a period. */
export function sessionOn(
  emulator: CfxEmulator,
  options: { pollMs?: number } = {},
): CfxSession {
  return new CfxSession({ acquire: async () => emulator, pollMs: options.pollMs ?? 2 });
}

/**
 * Break the pipe the way an unplug does: a transfer that fails on a handle Chrome has already
 * marked closed, which `CfxDevice`'s read pump treats as fatal at once rather than retrying.
 * The parked `transferIn` has to be woken for it to be seen at all, which is what the push is.
 */
export function drop(emulator: CfxEmulator): void {
  emulator.opened = false;
  emulator.transferInFailures.push(new Error("device disconnected"));
  emulator.push(new Uint8Array(0));
}

