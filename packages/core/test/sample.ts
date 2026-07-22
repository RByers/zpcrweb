import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the committed sample `.zpcr` at the repo root `samples/` dir. */
export const SAMPLE_PATH = resolve(here, "../../../samples/20260720.zpcr");

/** Raw bytes of the committed sample `.zpcr`. */
export function readSampleBytes(): Uint8Array {
  const buf = readFileSync(SAMPLE_PATH);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
