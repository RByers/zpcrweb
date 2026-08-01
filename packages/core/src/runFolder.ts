/**
 * Assemble a `.zpcr` from an instrument run directory's loose files.
 *
 * A `.zpcr` is a plain ZIP of exactly what the instrument keeps in `\Storage Card\CurrentRun`
 * (see `archive.ts` and `usb.md` §7): `RunInfo.xml`, the `Read*.Plateread` series, the `.Dcal`
 * set, the marker files, and whatever plate/protocol the run carried. So there is no format
 * conversion here — the files that come off the wire are the archive's entries verbatim, and
 * zipping them is the whole job.
 *
 * The counterpart to `attachPlate.ts`: both write a `.zpcr` with `fflate`'s `zipSync`, already a
 * dependency for reading.
 */

import { zipSync } from "fflate";
import { parseRunInfoRaw } from "./runinfo.js";

const RUNINFO_NAME = "RunInfo.xml";
const textDecoder = new TextDecoder("utf-8");

/** Strip any directory part from a Windows or POSIX path, so `RunInfo.xml`'s `DataFile` (which
 * the instrument may write as a full `\Storage Card\…` path) yields a plain file name. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? path : path.slice(cut + 1);
}

/**
 * The name the run calls itself: `RunInfo.xml`'s `DataFile`, which is already the `.zpcr` name
 * CFX Manager would save this run under (e.g. `20260720_211747_CT019138_Luna_noRT.zpcr`) — so a
 * run pulled off the instrument lands under the same name as the same run exported by hand.
 * Falls back to `CurrentRun.zpcr` when the field is absent or empty.
 */
export function zpcrNameFromRunFiles(files: Record<string, Uint8Array>): string {
  const runInfo = files[RUNINFO_NAME];
  if (runInfo === undefined) return "CurrentRun.zpcr";
  let dataFile = "";
  try {
    dataFile = parseRunInfoRaw(textDecoder.decode(runInfo))["DataFile"] ?? "";
  } catch {
    // A `RunInfo.xml` this app can't read is the caller's problem to report, via parseZpcr.
  }
  const name = baseName(dataFile.trim());
  if (name === "") return "CurrentRun.zpcr";
  return /\.zpcr$/i.test(name) ? name : `${name}.zpcr`;
}

/**
 * Zip a run directory's files into `.zpcr` bytes, named after the run (see
 * {@link zpcrNameFromRunFiles}). The result parses straight back through `parseZpcr`.
 *
 * Throws when `RunInfo.xml` is absent: without it there is no run metadata and `parseZpcr` would
 * reject the result anyway, so failing here names the actual problem — an incomplete set of
 * files — rather than handing back an archive that cannot be opened.
 */
export function zpcrFromRunFiles(files: Record<string, Uint8Array>): {
  name: string;
  bytes: Uint8Array;
} {
  if (files[RUNINFO_NAME] === undefined) {
    throw new Error(`Can't assemble a .zpcr: no ${RUNINFO_NAME} among the run's files`);
  }
  return { name: zpcrNameFromRunFiles(files), bytes: zipSync(files) };
}
