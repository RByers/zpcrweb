/**
 * Build a bare `.zpcr` for an experiment that hasn't been started yet — what "New experiment"
 * (About) and "Clone experiment" (Overview/Instrument) both call, differing only in which parts
 * they pass. See the app's "pending experiment" model: a `.zpcr` with no reads and no `begun`
 * marker, created explicitly and by name, editable in place (a protocol written directly, a plate
 * attached) until "Start experiment" turns it into an ordinary run.
 *
 * Unlike `runSeed.ts`'s seed archive (which this file replaces — see that module's removal), this
 * writes no `begun` marker: starting happens later, from the app, on a file that already exists.
 */
import { zipArchive, type ArchiveFiles } from "./archive.js";
import { parseRunDefinitionText } from "./prcl.js";
import { PROTOCOL_NAME_TXT } from "./usb/runPlan.js";
import { PROTOCOL_RUN_DEFINITION_NAME, canonicalPlateEntryName } from "./attachPlate.js";
import { ZPCRWEB_SETTINGS_NAME } from "./zpcrwebSettings.js";

export interface ExperimentArchiveParts {
  /** The protocol to start from — its run-definition text, and its own name (for
   * `ProtocolName.txt`), when it has one. Omit for "start from scratch": the experiment then holds
   * **no protocol entry at all**, and writing one is a deliberate act in the app (Overview's "new
   * protocol", or attaching a file). */
  protocol?: { runDefinition: string; name?: string };
  /** The plate to start from, as `.plt.csv` bytes (`plateToCsv()`) under the name it should carry
   * in the archive — reuses the plate's own identity when cloning a run, or a chosen name when
   * attaching one fresh. Omit when there's no plate yet. */
  plate?: { name: string; bytes: Uint8Array };
}

/**
 * Build the archive, holding **only the parts actually supplied**. An experiment created from
 * scratch therefore has no protocol and no plate in it, which is the literal truth about it — an
 * earlier version wrote a zero-length `ProtocolRunDefinition.txt` so that the result would parse,
 * and that was a protocol entry the file did not have, listed as one in its own Raw tab.
 *
 * What keeps it parseable instead is `zpcrweb.json`, always written: `parseZpcr` needs *some* entry
 * to identify an archive as a run rather than any ZIP that has been renamed (`zpcr.ts`), and this
 * app's own settings entry is the honest one to be that — it says "zpcrweb made this archive", by
 * presence rather than content, the way `begun`/`ended` do. It starts as an empty `{}` document and
 * fills in as the experiment is named and analysed (`zpcrweb-json.md`).
 */
export function buildExperimentArchive(parts: ExperimentArchiveParts): Uint8Array {
  return zipArchive(buildExperimentFiles(parts));
}

/** {@link buildExperimentArchive} without the zip — the map-level half of the pair described in
 * `archive.ts`. A new experiment is by definition a run that hasn't started, so this is the form
 * the app actually stores it in (see its `state/fileContent.ts`); zipping one only ever happens on
 * download. */
export function buildExperimentFiles(parts: ExperimentArchiveParts): ArchiveFiles {
  const encoder = new TextEncoder();
  const files: ArchiveFiles = {
    [ZPCRWEB_SETTINGS_NAME]: encoder.encode("{}"),
  };
  if (parts.protocol) {
    // The canonical one-line form the instrument writes, not the `.prcl.txt` file form — see
    // `attachProtocolToZpcr`, which says why the header must not land in an archive entry.
    files[PROTOCOL_RUN_DEFINITION_NAME] = encoder.encode(
      parseRunDefinitionText(parts.protocol.runDefinition),
    );
    const name = parts.protocol.name?.trim();
    if (name) files[PROTOCOL_NAME_TXT] = encoder.encode(name);
  }
  if (parts.plate) {
    files[canonicalPlateEntryName(parts.plate.name)] = parts.plate.bytes;
  }
  return files;
}
