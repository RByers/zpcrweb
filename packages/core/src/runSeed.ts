/**
 * The `.zpcr` a run gets the moment it is started, before the instrument has produced anything.
 *
 * A run's archive is normally assembled *backwards* — the instrument writes files, the app lists
 * the folder and zips what it finds (`runFolder.ts`). That leaves a window, from the click on
 * Start run to the first plate read, in which the run exists on the block and nowhere in this
 * app: no chip in the file bar, nothing to name, nothing to open. The window is minutes long (a
 * lid preheat and a first hold), and for that whole time the one thing the operator wants to look
 * at is the run they just started.
 *
 * So the file is created at the click, from the two halves that were staged plus the name that
 * was typed. It holds exactly what is known then and nothing else:
 *
 * | Entry | Why |
 * |-------|-----|
 * | `ProtocolRunDefinition.txt` | the protocol that was sent — the same entry a finished run has, so the Protocol view reads it with no special case |
 * | `ProtocolName.txt` | what that protocol is called, likewise |
 * | `<plate>.plt.csv` | the plate map that was deposited (`usb/runPlan.ts`) |
 * | `zpcrweb.json` | the run's name — the only place it can live (`experiment.ts`) |
 * | `begun` | the run has started and has not ended (`runFolder.ts`) |
 *
 * There is deliberately **no `RunInfo.xml`** and there are no plate reads: neither exists yet, and
 * writing a placeholder would mean inventing a serial number, a scan mask and a start time that
 * the instrument is about to state for itself. `parseZpcr` reads such an archive as a run whose
 * metadata is empty and whose read list is empty, and the app disables the views that have
 * nothing to show (curves, reference, calibration) rather than rendering them blank.
 *
 * Each subsequent pull replaces this file wholesale — same name, so the app supersedes it — and
 * the first one that includes the instrument's `RunInfo.xml` is a complete `.zpcr` in the ordinary
 * sense. Nothing downstream distinguishes a seed from a run in progress; the difference is only
 * which entries happen to be present.
 */

import { zipSync } from "fflate";
import { runFileBaseName } from "./experiment.js";
import { RUN_BEGUN_MARKER } from "./runFolder.js";
import type { RunPlan } from "./usb/runPlan.js";

export interface RunSeedOptions {
  /** What the run is called. Required, and required to be non-empty: a run this app started is
   * the one case where the name is known before anything else, and it is the whole reason this
   * file can exist before the instrument has written a byte. */
  experimentName: string;
  /**
   * What to call the file, without extension. Defaults to {@link runFileBaseName} of the
   * experiment name; the web app passes that same derivation stepped past any name already loaded
   * (`state/useRunNaming.ts`), and then pins it, so the seed and the snapshots that replace it
   * agree on a name without either having to ask the other.
   */
  fileBaseName?: string;
  /** The protocol's run-definition text, exactly as sent (`protocol.md`). */
  runDefinition: string;
  /** The protocol's own name, for `ProtocolName.txt`. Omitted when the protocol has none. */
  protocolName?: string;
  /**
   * The plan this run is being started from ({@link planRun}). Its uploads are copied in verbatim
   * — the plate `.plt.csv` and the `zpcrweb.json` carrying the name — rather than re-derived, so
   * the seed holds byte-for-byte what is being deposited in the run folder, under the same names.
   * The `.prcl.txt` upload is left out: an archive states its protocol as
   * `ProtocolRunDefinition.txt`, which is what the instrument will write there itself.
   */
  plan: RunPlan;
  /** When the run started; the file's date. Defaults to now, which is what a click means. */
  startedAt?: Date;
}

const PROTOCOL_NAME = "ProtocolRunDefinition.txt";
const PROTOCOL_NAME_TXT = "ProtocolName.txt";

/**
 * Build the seed `.zpcr` for a run being started. See the module comment for what it contains and
 * why that is all of it. Throws on a blank `experimentName`, which is a caller bug: the Instrument
 * view will not start a run without one (`usb/runPlan.ts`'s `no-experiment-name` check).
 */
export function zpcrSeedArchive(options: RunSeedOptions): { name: string; bytes: Uint8Array } {
  const experimentName = options.experimentName.trim();
  if (!experimentName) throw new Error("A run needs an experiment name before it can be started");
  const encoder = new TextEncoder();

  const files: Record<string, Uint8Array> = {
    [PROTOCOL_NAME]: encoder.encode(options.runDefinition),
    // Zero-content, like the instrument's own: only its presence means anything.
    [RUN_BEGUN_MARKER]: new Uint8Array(0),
  };
  for (const upload of options.plan.uploads) {
    if (/\.prcl\.txt$/i.test(upload.name)) continue;
    files[upload.name] = upload.bytes;
  }
  if (options.protocolName) files[PROTOCOL_NAME_TXT] = encoder.encode(options.protocolName);

  const base = options.fileBaseName?.trim() || runFileBaseName(experimentName, options.startedAt);
  return {
    name: `${base.replace(/\.zpcr$/i, "") || "CurrentRun"}.zpcr`,
    bytes: zipSync(files),
  };
}
