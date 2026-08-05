/**
 * Attach (or replace) a `.zpcr` archive's plate or protocol data — the write-side counterpart to
 * `Zpcr.plates()`/`Zpcr.protocol()`. Both are entry swaps on a {@link ZpcrArchive}: drop the
 * existing entry (or entries) for that half, add the new one(s). The result parses straight back
 * through `parseZpcrArchive`, or through `parseZpcr` once a caller has zipped it.
 */

import type { ZpcrArchive } from "./archive.js";
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
  throw new Error(`attachPlate: "${name}" is not a .pltd or .csv/.plt.csv file`);
}

/**
 * Return a new archive with `plateFile` as the run's plate, replacing any existing
 * `.pltd`/`.plt.csv` entries (at most one plate entry is kept — matches "uploading replaces the
 * plate"). Throws if `plateFile.name` isn't a recognized plate file name.
 *
 * Neither the input archive nor its entry bytes are modified.
 */
export function attachPlate(
  archive: ZpcrArchive,
  plateFile: { name: string; bytes: Uint8Array },
): ZpcrArchive {
  const entryName = canonicalPlateEntryName(plateFile.name);
  const next: ZpcrArchive = {};
  for (const [name, bytes] of Object.entries(archive)) {
    if (isPltdName(name) || isPlateCsvName(name)) continue;
    next[name] = bytes;
  }
  next[entryName] = plateFile.bytes;
  return next;
}

/**
 * Return a new archive with `protocol` as the run's thermal protocol, replacing whatever
 * `ProtocolRunDefinition.txt`/`ProtocolName.txt` were there before — the protocol-side mirror of
 * {@link attachPlate}.
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
 *
 * Since no ZIP is involved, this is cheap enough to be what in-place protocol editing calls on
 * every keystroke (the app's `setRunProtocolText`): replacing the run-definition entry costs one
 * `TextEncoder` call.
 */
export function attachProtocol(
  archive: ZpcrArchive,
  protocol: { runDefinition: string; name?: string },
): ZpcrArchive {
  const next: ZpcrArchive = {};
  for (const [name, bytes] of Object.entries(archive)) {
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
