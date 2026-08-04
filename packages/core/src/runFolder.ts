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
import { unzipArchive } from "./archive.js";
import { runFileBaseName } from "./experiment.js";
import { expectedPlateReads } from "./runDefinition.js";
import type { Zpcr } from "./types.js";
import { parseRunInfo, parseRunInfoRaw } from "./runinfo.js";
import { parseZpcrwebSettingsJson, ZPCRWEB_SETTINGS_NAME } from "./zpcrwebSettings.js";

const RUNINFO_NAME = "RunInfo.xml";
const textDecoder = new TextDecoder("utf-8");

/**
 * The two marker files the instrument writes around a run, and the whole of how "is this run
 * still going?" is answered.
 *
 * `begun` appears the moment `RemoteRun` is accepted; `ended` appears when the run finishes.
 * Measured from the reference capture, where successive `LISTALLFILES \Storage Card\CurrentRun`
 * responses show `begun` present from the start and `ended` arriving only in the final listing,
 * alongside the last plate read and the `.alf` report. Every committed `.zpcr` sample — all of
 * them complete runs — carries both.
 *
 * Both are zero-content markers: only their presence means anything.
 */
export const RUN_BEGUN_MARKER = "begun";
export const RUN_ENDED_MARKER = "ended";

/**
 * Add the `begun` marker to an existing `.zpcr` archive in memory — what "Start experiment" calls
 * on a pending experiment's own file instead of creating a new one (the app's `beginExperiment`).
 * Once this lands, `runProgressFromNames` reads the file as started, permanently: even at zero
 * plate reads it is no longer "pending" (see the app's definition of that state), only "in
 * progress". Zero-content, like the marker itself — only its presence means anything.
 */
export function markExperimentBegun(zpcrBytes: Uint8Array): Uint8Array {
  const files = unzipArchive(zpcrBytes);
  return zipSync({ ...files, [RUN_BEGUN_MARKER]: new Uint8Array(0) });
}

/** How far along a run is, read from nothing but which files exist. */
export interface RunProgress {
  /** The run has started. */
  begun: boolean;
  /** The run has finished — successfully or by being cancelled; the markers don't distinguish. */
  ended: boolean;
  /** Started and not yet finished. */
  inProgress: boolean;
  /** How many `Read*.Plateread` files exist, i.e. how many cycles have been read so far. */
  plateReads: number;
}

/**
 * Read a run's progress from a directory listing (or an archive's entry names).
 *
 * Deliberately derived rather than stored. A run's in-progress-ness is a fact about an instrument
 * at a moment, and the moment the app writes it down somewhere it can be wrong — a browser
 * reloaded mid-run, a file copied to another machine, a run cancelled while the tab was closed.
 * Since the answer is already present in the files themselves, and travels with them into the
 * assembled `.zpcr`, there is nothing to keep in sync.
 */
export function runProgressFromNames(names: readonly string[]): RunProgress {
  const set = new Set(names.map((n) => n.toLowerCase()));
  const begun = set.has(RUN_BEGUN_MARKER);
  const ended = set.has(RUN_ENDED_MARKER);
  return {
    begun,
    ended,
    inProgress: begun && !ended,
    plateReads: names.filter((n) => /\.Plateread$/i.test(n)).length,
  };
}

/**
 * Whether a run did everything its protocol asked for — see {@link runCompleteness}.
 */
export interface RunCompleteness {
  /** Plate reads the protocol implies, or null when that can't be answered honestly. */
  expected: number | null;
  /** Plate reads the run actually produced. */
  actual: number;
  /** The run is over, and produced fewer reads than the protocol implies. */
  incomplete: boolean;
}

/**
 * Did this run finish its protocol, or stop short?
 *
 * **Nothing in a run's own files says it was cancelled.** Measured against a run aborted over USB
 * mid-protocol: the `ended` marker is written exactly as for a normal finish, and the `.alf` run
 * report's user-aborted flag stays `False` with the sentinel line still reading
 * `Protocol completed.` (`alf.md` §6, `usb.md` §7.8). The one durable, format-independent
 * signature left is the one `usb.md` §7.8 step 6 names: **a cancelled run is a run with fewer
 * plate reads than its protocol implies.** So that is what this compares, and it is a comparison
 * rather than a flag on purpose — it works on any run, from any source, including one this app
 * never watched.
 *
 * Four ways it deliberately declines to accuse:
 *
 * - **A run still in progress is not incomplete**, it is unfinished. `begun` without `ended` is
 *   already its own state ({@link RunProgress.inProgress}) and the app says so separately.
 * - **A run that never started is not incomplete either**, it is *pending* — an experiment prepared
 *   but not yet run (`experimentArchive.ts`). It has a protocol calling for reads and no reads,
 *   which is the exact arithmetic this function accuses on, so without this every pending experiment
 *   would be flagged as a cancelled run. An archive that keeps markers at all (`archive.entries`
 *   non-empty) and has no `begun` has not started; a format with no markers to keep — a `.pcrd`, a
 *   Biomeme export — is finished by construction and still judged on the read count, which is what
 *   keeps a run cancelled in CFX Manager recognisable.
 * - **A protocol whose read count can't be predicted** yields `expected: null` and never
 *   `incomplete` — see {@link expectedPlateReads} for the three cases.
 * - **More reads than expected is not incomplete.** `ADDCYCLES` extends a running protocol's loop
 *   (`usb.md` §3), so over-delivery is ordinary.
 *
 * A format with no marker files — a `.pcrd` or a Biomeme export, whose `archive.entries` is empty
 * — is a finished record by construction, so it is judged on the read count alone. That is what
 * lets a run cancelled in CFX Manager and saved as a `.pcrd` be recognised too.
 */
export function runCompleteness(zpcr: Zpcr): RunCompleteness {
  const actual = zpcr.reads.length;
  const progress = runProgressFromNames(zpcr.archive.entries);
  const expected = zpcr.protocolText ? expectedPlateReads(zpcr.protocolText) : null;
  // See the "never started" case above: only an archive that keeps markers can be *known* not to
  // have started, so a format carrying none is taken as started rather than as pending.
  const started = progress.begun || zpcr.archive.entries.length === 0;
  return {
    expected,
    actual,
    incomplete: started && !progress.inProgress && expected !== null && actual < expected,
  };
}

/** Strip any directory part from a Windows or POSIX path, so `RunInfo.xml`'s `DataFile` (which
 * the instrument may write as a full `\Storage Card\…` path) yields a plain file name. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? path : path.slice(cut + 1);
}

/** What a caller knows about the run being assembled that the folder itself cannot say. */
export interface RunFolderNaming {
  /**
   * The run's name as the app currently holds it. Only used to confirm that {@link fileName}
   * describes *this* run — see {@link zpcrNameFromRunFiles}.
   */
  experimentName?: string;
  /** The file base name this run's archive already goes by (no extension). */
  fileName?: string;
}

/** Strip a `.zpcr` extension and any path, so a caller may pass either form. */
function fileBase(name: string): string {
  return baseName(name.trim()).replace(/\.zpcr$/i, "");
}

/**
 * What to call the `.zpcr` this folder becomes, in three rungs.
 *
 * 1. **The name this run's file already has**, `naming.fileName` — fixed when the app started the
 *    run and pinned for its duration (`state/useRunNaming.ts`), and applied only to the run that
 *    was started, which is what the `zpcrweb.json` deposited into the run folder
 *    (`usb/runPlan.ts`) attests: nothing else writes that entry there, and its `experimentName`
 *    matching `naming.experimentName` is what says the staged run and the folder are the same
 *    run rather than a new name typed over a run still finishing.
 * 2. **The deposited name**, `<YYYYMMDD>-<name>` via {@link runFileBaseName} — the same
 *    derivation the Instrument view offers as its default, so a browser reloaded mid-run (which
 *    forgets what was typed) still lands the file under the name the run was started with.
 *    Dated from the run's own `RunStartTime` when that parses, so the name says when the run
 *    happened rather than when it was pulled.
 * 3. **The name the run calls itself**: `RunInfo.xml`'s `DataFile`, already the `.zpcr` name CFX
 *    Manager would save this run under (e.g. `20260720_211747_CT019138_Luna_noRT.zpcr`), so a run
 *    started at the touchscreen or by Manager lands under the same name as the same run exported
 *    by hand. Falls back to `CurrentRun.zpcr` when the field is absent or empty.
 */
export function zpcrNameFromRunFiles(
  files: Record<string, Uint8Array>,
  naming?: RunFolderNaming,
): string {
  const runInfo = files[RUNINFO_NAME];
  if (runInfo === undefined) return "CurrentRun.zpcr";

  const deposited = depositedName(files);
  if (deposited) {
    const chosen = fileBase(naming?.fileName ?? "");
    if (chosen && naming?.experimentName?.trim() === deposited) return `${chosen}.zpcr`;
    const derived = runFileBaseName(deposited, runStartDate(runInfo));
    if (derived) return `${derived}.zpcr`;
  }

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

/** The run name this app deposited into the folder when it started the run, or `""`. */
function depositedName(files: Record<string, Uint8Array>): string {
  const settings = files[ZPCRWEB_SETTINGS_NAME];
  if (settings === undefined) return "";
  try {
    return parseZpcrwebSettingsJson(textDecoder.decode(settings))?.experimentName ?? "";
  } catch {
    return "";
  }
}

/** When the run started, for the derived name's date stamp; today when the field won't parse. */
function runStartDate(runInfo: Uint8Array): Date {
  try {
    return parseRunInfo(textDecoder.decode(runInfo)).runStartDate ?? new Date();
  } catch {
    return new Date();
  }
}

/**
 * Zip a run directory's files into `.zpcr` bytes, named after the run (see
 * {@link zpcrNameFromRunFiles}). The result parses straight back through `parseZpcr`.
 *
 * Throws when `RunInfo.xml` is absent: without it there is no run metadata and `parseZpcr` would
 * reject the result anyway, so failing here names the actual problem — an incomplete set of
 * files — rather than handing back an archive that cannot be opened.
 */
export function zpcrFromRunFiles(
  files: Record<string, Uint8Array>,
  naming?: RunFolderNaming,
): {
  name: string;
  bytes: Uint8Array;
} {
  if (files[RUNINFO_NAME] === undefined) {
    throw new Error(`Can't assemble a .zpcr: no ${RUNINFO_NAME} among the run's files`);
  }
  return { name: zpcrNameFromRunFiles(files, naming), bytes: zipSync(files) };
}
