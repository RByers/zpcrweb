import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { unzipArchive, type ZpcrArchive } from "../src/index.js";

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
 * A committed run whose second plate-read step is a **melt curve**: 40 amplification reads at
 * 60 °C, then 61 reads ramping 65 → 95 °C in 0.5 °C steps (`melt.md` §2). Its `.prcl` is
 * encrypted and its protocol text carries no `MELT` directive, so it is also the case that proves
 * melt detection needs neither.
 */
export const MELT_SAMPLE_PATH = resolve(
  here,
  "../../../samples/20230829_135443_CT019138_SINGLE_STEP_.zpcr",
);

/** Raw bytes of the melt-curve sample. */
export function readMeltBytes(): Uint8Array {
  const buf = readFileSync(MELT_SAMPLE_PATH);
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

/** The committed sample, unpacked — the form every archive function in the library takes (a
 * `.zpcr` is a ZIP only at rest; see `archive.ts`'s `ZpcrArchive`). */
export function readSampleArchive(): ZpcrArchive {
  return unzipArchive(readSampleBytes());
}

/** The multi-step sample, unpacked — see {@link readSampleArchive}. */
export function readMultistepArchive(): ZpcrArchive {
  return unzipArchive(readMultistepBytes());
}

/**
 * The committed **mixed-vessel** plate: three columns of a commercial 4-dye respiratory panel in
 * white strip tubes beside one column of the operator's own RVP multiplex in clear ones. The one
 * committed plate a CFX format could not express (`pltcsv.md` §3.1) — and it carries two
 * channel-2 dyes in different wells besides (`calibration.md` §3.2), so it keeps both rules
 * honest.
 */
export const MIXED_VESSEL_PLATE_PATH = resolve(
  here,
  "../../../samples/mixed-vessel-YouSeq-RVP.plt.csv",
);

/** Text of the mixed-vessel plate sample. */
export function readMixedVesselPlateText(): string {
  return readFileSync(MIXED_VESSEL_PLATE_PATH, "utf8");
}
