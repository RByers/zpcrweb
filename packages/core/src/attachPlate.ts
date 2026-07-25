/**
 * Attach (or replace) a `.zpcr` archive's plate data in memory — the write-side counterpart to
 * `Zpcr.plates()`. `.zpcr` is a plain ZIP (see `archive.ts`), and `fflate` (already a dependency
 * for reading) can write one too, so "attach a plate" is just: drop any existing plate entry,
 * add the new one, re-zip. The result round-trips straight back through `parseZpcr`.
 */

import { zipSync } from "fflate";
import { unzipArchive } from "./archive.js";
import { isPltdName } from "./pltd.js";
import { isPlateCsvName } from "./plateCsv.js";

/** Drop a `.csv`/`.CSV` extension and append `.plt.csv`, so an uploaded plain `.csv` (not
 * already named `.plt.csv`) still lands in the archive under zpcrweb's canonical plate-CSV
 * name. Any other name (e.g. a real `.pltd`) is kept as-is. */
function canonicalPlateEntryName(name: string): string {
  if (isPltdName(name) || isPlateCsvName(name)) return name;
  if (/\.csv$/i.test(name)) return `${name.replace(/\.csv$/i, "")}.plt.csv`;
  throw new Error(`attachPlateToZpcr: "${name}" is not a .pltd or .csv/.plt.csv file`);
}

/**
 * Return new `.zpcr` bytes with `plateFile` added as the run's plate, replacing any existing
 * `.pltd`/`.plt.csv` entries (at most one plate entry is kept — matches "uploading replaces the
 * plate"). Throws if `zpcrBytes` isn't a valid ZIP or `plateFile.name` isn't a recognized plate
 * file name.
 */
export function attachPlateToZpcr(
  zpcrBytes: Uint8Array,
  plateFile: { name: string; bytes: Uint8Array },
): Uint8Array {
  const entryName = canonicalPlateEntryName(plateFile.name);
  const files = unzipArchive(zpcrBytes);
  const next: Record<string, Uint8Array> = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (isPltdName(name) || isPlateCsvName(name)) continue;
    next[name] = bytes;
  }
  next[entryName] = plateFile.bytes;
  return zipSync(next);
}
