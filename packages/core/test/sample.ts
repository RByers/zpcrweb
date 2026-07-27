import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

/** Absolute path to the committed sample `.zpcr` at the repo root `samples/` dir. */
export const SAMPLE_PATH = resolve(here, "../../../samples/20260720_FirstQualification.zpcr");

/** Raw bytes of the committed sample `.zpcr`. */
export function readSampleBytes(): Uint8Array {
  const buf = readFileSync(SAMPLE_PATH);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/** A committed multi-step sample: a protocol with two PLATEREAD steps (2 + 8 reads). */
export const MULTISTEP_SAMPLE_PATH = resolve(
  here,
  "../../../samples/20190516_122922_CT019138_SHORT_QUALIF.zpcr",
);

/** Raw bytes of the multi-step sample. */
export function readMultistepBytes(): Uint8Array {
  const buf = readFileSync(MULTISTEP_SAMPLE_PATH);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * A committed run whose protocol contains a real `GradientStep` (55–65 °C across the block's
 * rows). The one sample that could plausibly carry per-row block temperatures — it doesn't; see
 * `plateread.md` §3.
 */
export const GRADIENT_SAMPLE_PATH = resolve(
  here,
  "../../../samples/20260725_GRADIENTTEST.zpcr",
);

/** Raw bytes of the gradient-protocol sample. */
export function readGradientBytes(): Uint8Array {
  const buf = readFileSync(GRADIENT_SAMPLE_PATH);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

/**
 * A committed **standalone** `.pltd` — a plate definition saved on its own, not inside a
 * `.zpcr`. Method-9 (DEFLATE64) and 5 dyes, so it also covers the compression variant and the
 * multi-dye layout the in-archive samples don't. Its decrypted plaintext sits beside it as
 * `…​.pltd.xml`, so the structural tests need no password.
 */
export const STANDALONE_PLTD_PATH = resolve(
  here,
  "../../../samples/QuickPlate_96 wells_All Channels.pltd",
);

/** Raw bytes of the standalone `.pltd` sample. */
export function readStandalonePltdBytes(): Uint8Array {
  const buf = readFileSync(STANDALONE_PLTD_PATH);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
