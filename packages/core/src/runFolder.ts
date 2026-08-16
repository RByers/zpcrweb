/**
 * Assemble a `.zpcr` from an instrument run directory's loose files.
 *
 * A `.zpcr` is a plain ZIP of exactly what the instrument keeps in `\Storage Card\CurrentRun`
 * (see `archive.ts` and `usb.md` §7): `RunInfo.xml`, the `Read*.Plateread` series, the `.Dcal`
 * set, the marker files, and whatever plate/protocol the run carried. So a run directory already
 * *is* a {@link ZpcrArchive} — there is no format conversion here, and nothing to assemble. All
 * {@link zpcrFromRunFiles} does is check that the folder is a run and work out what it should be
 * called; `zipArchive` is the separate step that makes it a file, for a caller that wants one.
 */

import type { ZpcrArchive } from "./archive.js";
import { runFileBaseName } from "./experiment.js";
import { isPlateCsvName } from "./plateCsv.js";
import { isPltdName } from "./pltd.js";
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
 * Add the `begun` marker to an existing archive — what "Start experiment" calls
 * on a pending experiment's own file instead of creating a new one (the app's `beginExperiment`).
 * Once this lands, `runProgressFromNames` reads the file as started, permanently: even at zero
 * plate reads it is no longer "pending" (see the app's definition of that state), only "in
 * progress". Zero-content, like the marker itself — only its presence means anything.
 */
export function markExperimentBegun(archive: ZpcrArchive): ZpcrArchive {
  return { ...archive, [RUN_BEGUN_MARKER]: new Uint8Array(0) };
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
  /**
   * The name this run's archive already goes by, with or without its `.zpcr` extension — and
   * **with any directory part kept**. A caller may name a file by a path (the app names a file
   * opened out of a granted folder by its path within that folder), and that path is part of which
   * file this is: strip it and the run's snapshots land under a bare name, i.e. beside the file
   * they are snapshots of rather than in it.
   */
  fileName?: string;
}

/** A caller's file name as a `.zpcr` name: its own extension if it has one, else appended. Any
 * directory part is left exactly as given — see {@link RunFolderNaming.fileName}. */
function zpcrFileName(name: string): string {
  const trimmed = name.trim();
  return /\.zpcr$/i.test(trimmed) ? trimmed : `${trimmed}.zpcr`;
}

/**
 * What to call the `.zpcr` this folder becomes, in three rungs.
 *
 * 1. **The name this run's file already has**, `naming.fileName` — fixed when the app started the
 *    run and pinned for its duration (`state/useRunNaming.ts`), and applied only to the run that
 *    was started, which is what the `zpcrweb.json` deposited into the run folder
 *    (`usb/runPlan.ts`) attests: nothing else writes that entry there, and its `experimentName`
 *    matching `naming.experimentName` is what says the staged run and the folder are the same
 *    run rather than a new name typed over a run still finishing. Returned **verbatim**, directory
 *    part and all: the name is how the caller identifies the file it is already holding, so any
 *    part of it this dropped would name a different file.
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
  files: ZpcrArchive,
  naming?: RunFolderNaming,
): string {
  const runInfo = files[RUNINFO_NAME];
  if (runInfo === undefined) return "CurrentRun.zpcr";

  const deposited = depositedName(files);
  if (deposited) {
    const chosen = naming?.fileName?.trim() ?? "";
    if (chosen && naming?.experimentName?.trim() === deposited) return zpcrFileName(chosen);
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
function depositedName(files: ZpcrArchive): string {
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
 * Read a run directory as the `.zpcr` archive it already is: the same entries back, plus what the
 * run should be called (see {@link zpcrNameFromRunFiles}).
 *
 * The archive is returned rather than zipped because that is what a caller following a live run
 * wants — every cycle re-assembles the whole run from ~40 cached files, and zipping that to hand
 * it over, only for the receiving side to unzip it again to read it, was the single most expensive
 * thing a plate read cost (the app's `useRunWatch` and `state/fileContent.ts`). A caller that
 * wants a file writes `zipArchive(archive)`.
 *
 * Throws when `RunInfo.xml` is absent: without it there is no run metadata and `parseZpcr` would
 * reject the archive anyway, so failing here names the actual problem — an incomplete set of
 * files — rather than handing back something that cannot be opened.
 */
export function zpcrFromRunFiles(
  files: ZpcrArchive,
  naming?: RunFolderNaming,
): { name: string; archive: ZpcrArchive } {
  if (files[RUNINFO_NAME] === undefined) {
    throw new Error(`Can't assemble a .zpcr: no ${RUNINFO_NAME} among the run's files`);
  }
  return { name: zpcrNameFromRunFiles(files, naming), archive: files };
}

/**
 * The entries that say *which run* a folder holds: `RunInfo.xml`, which every run has and which
 * {@link zpcrNameFromRunFiles} names it from, and the `zpcrweb.json` this app deposits when it
 * starts one.
 *
 * Two of the folder's forty files, and small (~8 KB against ~400 KB), which is the point: a caller
 * that already has an archive of a run can read these first, decide whether the folder still holds
 * *that* run, and fetch nothing else if it does. Filtered against a listing rather than returned
 * as constants because neither is guaranteed to be there — `RunInfo.xml` is deposited a moment
 * after the run starts, and a run begun at the instrument's own touchscreen never gets a
 * `zpcrweb.json` at all.
 */
export function runIdentityFileNames(names: readonly string[]): string[] {
  return names.filter((n) => n === RUNINFO_NAME || n === ZPCRWEB_SETTINGS_NAME);
}

/**
 * Is `held` an archive of the run these folder files describe?
 *
 * `RunInfo.xml` is the run's own identity record — its identifier, its start time, the file name
 * CFX Manager would give it — and the instrument clears the run folder when a run starts, so a
 * folder whose `RunInfo.xml` differs byte for byte from an archive's is a *different* run that
 * happens to be in the same place. Answering `false` costs the caller a full download; answering
 * `true` wrongly would append one run's plate reads to another run's file, so the comparison is
 * exact and an archive with no `RunInfo.xml` at all is never a match.
 */
export function isSameRun(held: ZpcrArchive | null | undefined, folder: ZpcrArchive): boolean {
  const mine = held?.[RUNINFO_NAME];
  const theirs = folder[RUNINFO_NAME];
  if (mine === undefined || theirs === undefined) return false;
  if (mine === theirs) return true;
  if (mine.length !== theirs.length) return false;
  return mine.every((b, i) => b === theirs[i]);
}

/**
 * Has this archive ever had a run's own identity record written into it?
 *
 * The complement to {@link isSameRun}, for the case that comparison cannot speak to: an archive
 * with no `RunInfo.xml` isn't a *different* run, it is a `.zpcr` that has never received anything
 * from an instrument — a pending experiment, made in the app and not yet started, or started
 * somewhere else so that this copy of it is still the pre-run one. A caller deciding which file a
 * run belongs to can treat that as the file the run came from, where a mismatched `RunInfo.xml`
 * has to be treated as somebody else's run.
 */
export function hasRunIdentity(held: ZpcrArchive | null | undefined): boolean {
  return held?.[RUNINFO_NAME] !== undefined;
}

/**
 * Which of a run folder's files an archive of that run still needs — the download list for a
 * caller following a run as it happens (the app's `useRunWatch`).
 *
 * **The run's own file is the only copy there is.** Nothing else remembers what has been
 * downloaded, so this answers it from the archive itself, which is what makes the app's copy of a
 * run and what it has fetched the same fact: delete the file and every byte is fetched again, keep
 * it and only what the instrument has newly written is.
 *
 * Three rules:
 *
 * - **No archive** — nothing is held, so everything is wanted. A run this app has never seen, or
 *   one whose file the user deleted.
 * - **An entry the archive already has is not fetched again.** A file the instrument has written
 *   is final, and a new plate read arrives under a new name, so a cycle's download is exactly the
 *   one ~22 KB read that cycle produced. `rewritten` is the exception: the handful of files the
 *   instrument *revises* as a run goes on (`runlog.xml` grows an entry per event,
 *   `lastplatereadstatus` counts the reads), which a caller re-reads once at the end of the run,
 *   where the archive has to be complete.
 * - **A plate is not fetched into an archive that already has one.** Alone among a run's files, a
 *   plate's *entry name* is not fixed — a `.pltd` from the instrument, a `.plt.csv` written here —
 *   so a user who replaces the plate of a run in progress leaves the folder's copy looking like a
 *   file the archive is missing. It isn't: the folder's plate is the one this app deposited there
 *   when it started the run, so an archive that already carries a plate has nothing to learn by
 *   re-reading it, and re-reading it would put back the plate the user replaced.
 */
export function runFilesToFetch(
  held: ZpcrArchive | null | undefined,
  names: readonly string[],
  rewritten?: ReadonlySet<string>,
): string[] {
  if (!held) return [...names];
  const hasPlate = Object.keys(held).some((n) => isPltdName(n) || isPlateCsvName(n));
  return names.filter((name) => {
    if (hasPlate && (isPltdName(name) || isPlateCsvName(name))) return false;
    if (held[name] === undefined) return true;
    return rewritten?.has(name.toLowerCase()) === true;
  });
}
