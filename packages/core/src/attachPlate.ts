/**
 * Attach (or replace) a `.zpcr` archive's plate or protocol data in memory — the write-side
 * counterpart to `Zpcr.plates()`/`Zpcr.protocol()`. `.zpcr` is a plain ZIP (see `archive.ts`), and
 * `fflate` (already a dependency for reading) can write one too, so "attach a plate/protocol" is
 * just: drop the existing entry (or entries) for that half, add the new one(s), re-zip. The
 * result round-trips straight back through `parseZpcr`.
 */

import { unzipArchive, zipArchive, type ArchiveFiles } from "./archive.js";
import { isPltdName } from "./pltd.js";
import { isPlateCsvName } from "./plateCsv.js";
import { parseRunDefinitionText } from "./prcl.js";
import { PROTOCOL_NAME_TXT } from "./usb/runPlan.js";

/** The archive entry a run's thermal protocol lives under — `zpcr.ts`'s own name for it, not
 * exported there, so this and `experimentArchive.ts` each need their own copy of the string. */
export const PROTOCOL_RUN_DEFINITION_NAME = "ProtocolRunDefinition.txt";

/** Drop a `.csv`/`.CSV` extension and append `.plt.csv`, so an uploaded plain `.csv` (not
 * already named `.plt.csv`) still lands in the archive under zpcrweb's canonical plate-CSV
 * name. Any other name (e.g. a real `.pltd`) is kept as-is. Exported for `experimentArchive.ts`,
 * which names a fresh experiment's plate entry the same way. */
export function canonicalPlateEntryName(name: string): string {
  if (isPltdName(name) || isPlateCsvName(name)) return name;
  if (/\.csv$/i.test(name)) return `${name.replace(/\.csv$/i, "")}.plt.csv`;
  throw new Error(`attachPlateToZpcr: "${name}" is not a .pltd or .csv/.plt.csv file`);
}

/**
 * Return a new archive map with `plateFile` as the run's plate, replacing any existing
 * `.pltd`/`.plt.csv` entries (at most one plate entry is kept — matches "uploading replaces the
 * plate"). Throws if `plateFile.name` isn't a recognized plate file name.
 *
 * The map-level half of the pair described in `archive.ts`; {@link attachPlateToZpcr} is the same
 * operation on zipped bytes.
 */
export function attachPlateToFiles(
  files: ArchiveFiles,
  plateFile: { name: string; bytes: Uint8Array },
): ArchiveFiles {
  const entryName = canonicalPlateEntryName(plateFile.name);
  const next: ArchiveFiles = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (isPltdName(name) || isPlateCsvName(name)) continue;
    next[name] = bytes;
  }
  next[entryName] = plateFile.bytes;
  return next;
}

/**
 * Return new `.zpcr` bytes with `plateFile` added as the run's plate — {@link attachPlateToFiles}
 * with an unzip in front and a re-zip behind. Throws if `zpcrBytes` isn't a valid ZIP or
 * `plateFile.name` isn't a recognized plate file name.
 */
export function attachPlateToZpcr(
  zpcrBytes: Uint8Array,
  plateFile: { name: string; bytes: Uint8Array },
): Uint8Array {
  return zipArchive(attachPlateToFiles(unzipArchive(zpcrBytes), plateFile));
}

/**
 * Return new `.zpcr` bytes with `protocol` as the run's thermal protocol, replacing whatever
 * `ProtocolRunDefinition.txt`/`ProtocolName.txt` were there before — the protocol-side mirror of
 * {@link attachPlateToZpcr}.
 *
 * This is also what in-place protocol editing calls on every keystroke (the app's
 * `setRunProtocolText`, throttled the way `setProtocolText` throttles a standalone `.prcl.txt`):
 * attaching a whole different protocol and editing the one already there are the same operation
 * at this layer, "replace the run-definition text this archive carries". `protocol.name` is
 * written as `ProtocolName.txt` only when non-blank, the same "nothing to say" rule
 * `usb/runPlan.ts`'s deposit uses — an unnamed protocol simply has no name entry, rather than an
 * empty one.
 *
 * The entry is written in the **canonical one-line form the instrument itself writes**, via
 * {@link parseRunDefinitionText} — which also accepts a standalone `.prcl.txt` body and strips its
 * header, so a caller may pass either form. Not `formatRunDefinitionText`: that adds the
 * `[ProtocolRunDefinition version …]` header, which belongs to a `.prcl.txt` *file* and not to this
 * archive entry (no sample carries one here). Writing it meant `Zpcr.protocolText` — which is the
 * raw entry, unlike a standalone protocol file's text, which the app normalizes on load — handed
 * that header to `ProtocolBuilder`, which refused the whole protocol as an unrecognized directive.
 */
export function attachProtocolToZpcr(
  zpcrBytes: Uint8Array,
  protocol: { runDefinition: string; name?: string },
): Uint8Array {
  return zipArchive(attachProtocolToFiles(unzipArchive(zpcrBytes), protocol));
}

/**
 * {@link attachProtocolToZpcr} on an open archive map rather than on zipped bytes — the map-level
 * half of the pair described in `archive.ts`, and the one in-place protocol editing actually
 * wants: a pending experiment's archive is held open while it is being edited, so replacing the
 * run-definition entry on a keystroke costs one `TextEncoder` call and no ZIP work at all.
 */
export function attachProtocolToFiles(
  files: ArchiveFiles,
  protocol: { runDefinition: string; name?: string },
): ArchiveFiles {
  const next: ArchiveFiles = {};
  for (const [name, bytes] of Object.entries(files)) {
    if (name === PROTOCOL_RUN_DEFINITION_NAME || name === PROTOCOL_NAME_TXT) continue;
    next[name] = bytes;
  }
  next[PROTOCOL_RUN_DEFINITION_NAME] = new TextEncoder().encode(
    parseRunDefinitionText(protocol.runDefinition),
  );
  const name = protocol.name?.trim();
  if (name) next[PROTOCOL_NAME_TXT] = new TextEncoder().encode(name);
  return next;
}
