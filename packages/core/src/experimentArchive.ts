/**
 * Build a bare `.zpcr` for an experiment that hasn't been started yet — what "New experiment"
 * (About) and "Clone experiment" (Overview/Instrument) both call, differing only in which parts
 * they pass. See the app's "pending experiment" model: a `.zpcr` with no reads and no `begun`
 * marker, created explicitly and by name, editable in place (a protocol typed directly, a plate
 * attached) until "Start experiment" turns it into an ordinary run.
 *
 * Unlike `runSeed.ts`'s seed archive (which this file replaces — see that module's removal), this
 * writes **no `begun` marker and no `zpcrweb.json`**: naming and starting both happen later, from
 * the app, once the file already exists to be named and started.
 */
import { zipSync } from "fflate";
import { formatRunDefinitionText } from "./prcl.js";
import { PROTOCOL_NAME_TXT } from "./usb/runPlan.js";
import { PROTOCOL_RUN_DEFINITION_NAME, canonicalPlateEntryName } from "./attachPlate.js";

export interface ExperimentArchiveParts {
  /** The protocol to start from — its run-definition text, and its own name (for
   * `ProtocolName.txt`), when it has one. Omit for "start from scratch": the Protocol tab then
   * opens on the blank default protocol, with nothing written to the archive until it's edited. */
  protocol?: { runDefinition: string; name?: string };
  /** The plate to start from, as `.plt.csv` bytes (`plateToCsv()`) under the name it should carry
   * in the archive — reuses the plate's own identity when cloning a run, or a chosen name when
   * attaching one fresh. Omit when there's no plate yet. */
  plate?: { name: string; bytes: Uint8Array };
}

/**
 * Build the archive. Even with both parts omitted, the result still parses as a `.zpcr`: a
 * zero-length `ProtocolRunDefinition.txt` is always written, purely so its *name* satisfies
 * `parseZpcr`'s own guard against an archive with nothing in it identifying it as a run
 * (`zpcr.ts`) — the same "presence is the whole signal" trick `begun`/`ended` use elsewhere in
 * this format. Empty content reads back as no protocol at all (`Zpcr.protocolText`/`protocol()`
 * both treat it as absent), so this changes nothing about what "pending, no protocol yet" means —
 * it only keeps a from-scratch experiment openable before anything has been typed into it.
 */
export function buildExperimentArchive(parts: ExperimentArchiveParts): Uint8Array {
  const files: Record<string, Uint8Array> = {
    [PROTOCOL_RUN_DEFINITION_NAME]: new Uint8Array(0),
  };
  if (parts.protocol) {
    files[PROTOCOL_RUN_DEFINITION_NAME] = new TextEncoder().encode(
      formatRunDefinitionText(parts.protocol.runDefinition),
    );
    const name = parts.protocol.name?.trim();
    if (name) files[PROTOCOL_NAME_TXT] = new TextEncoder().encode(name);
  }
  if (parts.plate) {
    files[canonicalPlateEntryName(parts.plate.name)] = parts.plate.bytes;
  }
  return zipSync(files);
}
