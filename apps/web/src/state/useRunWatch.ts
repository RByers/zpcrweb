/**
 * Follow a run that is happening right now, and keep a `.zpcr` of it in the app's file list.
 *
 * **`STATUS?` is the progress signal, not the filesystem** (`usb.md` §7.5). Its current-step field
 * carries the running step's command text verbatim, and a completed `.Plateread` appears in the
 * run folder when that step *ends* — so the rule is to watch for the step leaving a `PLATEREAD`
 * and list the directory then, rather than polling the filesystem hopefully. The status poll is
 * already running for the rail, so this costs nothing extra and reacts within a poll period
 * instead of within a listing period.
 *
 * Listing the folder is entirely **edge-triggered**, never on a timer: a `GETFILESLEN`+
 * `LISTALLFILES` round trip holds `useCfxDevice`'s `busy` flag, and a periodic listing here used to
 * flicker the Instrument rail's Start-run button (which disables while `busy`) every 30 s, even
 * with no run in progress. What's left is exactly §7.5/§7.7's own two triggers — the step-transition
 * rule above for every read but the last, and the §7.6 acknowledgement (`finish` below), which is
 * also where the **last** read — `PLATEREAD` → `IDLE` — actually becomes listable — plus one
 * baseline listing on connect, below, needed only to make the "first listing is never downloaded"
 * rule work at all. Nothing here lists on a run merely *starting*: usb.md doesn't call for it, and
 * `STATUS?`'s `running` flag already says so live without a listing — the `begun` marker is a
 * property of the archive this watcher assembles, not of what the rail shows moment to moment, so
 * it can wait for the first listing a real edge triggers anyway. That edge is watched, though,
 * purely to tell a run *starting* from one *found* already going (a reconnect, or a page load
 * mid-run) — the two produce an identical listing, but only the live `running` false→true
 * transition tells them apart, which is what lets the file that transition's next listing
 * eventually produces be selected unconditionally (see `onRun`'s `activate` below).
 *
 * When a listing turns out to differ from the last one, whatever is new is pulled and handed to
 * the store, which merges it into the file of that name (see `onRun` below — what goes over is
 * what the instrument just wrote, not the folder re-assembled). Nothing is zipped on the way: a
 * run still going is kept open and appended to, and only the
 * end-of-run snapshot becomes an ordinary `.zpcr` file (see `state/fileContent.ts`). What that name is comes from
 * `runFolder.ts`: the file name typed in the Instrument view for a run this app started, and
 * otherwise whatever the run itself says it is called.
 *
 * Three things make that affordable enough to do every cycle:
 *
 * - **Only new files are fetched, and the run's own file says which those are.** A `CurrentRun` is
 *   ~40 files, 28 of which are the `.Dcal` calibration set that never changes during a run;
 *   re-pulling those every cycle would put megabytes over a 64-byte-packet bulk endpoint for
 *   nothing. So each pass reads back the archive the app is holding for this run (`heldRun`) and
 *   fetches only what it lacks (`runFilesToFetch`) — a file the instrument has written is final,
 *   and a new plate read arrives under a new name, so a cycle's download is exactly one 22 KB
 *   read. The files that *are* rewritten as the run goes (`REFETCH_AT_END`) are re-read once, on
 *   the end-of-run pass, where the archive has to be complete.
 *
 *   **Nothing is remembered here about what has been downloaded** — the app's copy of the run *is*
 *   that record. This hook used to keep its own name→bytes map of the folder, which was the same
 *   ~400 KB held twice and could disagree with the file the user actually has: delete a run
 *   mid-way and the watcher went on believing it had every byte, so the file never came back. Now
 *   the question "what do we have?" has one answer, and a run whose file is gone is downloaded
 *   again from the top, finished or not.
 * - **The first listing is never downloaded — unless it's already running.** `CurrentRun` usually
 *   holds the *previous* run when you connect, finished and complete with its `ended` marker.
 *   Pulling that unasked would be a surprise 400 KB transfer and an unrequested file in the bar,
 *   so the first sighting ordinarily only records the listing to compare later ones against.
 *   But the folder can just as well hold a run that is genuinely `begun` and not yet `ended` — a
 *   browser reload mid-run, or the instrument only plugged in (or the app's connect button only
 *   pressed) after the run had already started — and there the "wait for the next change" rule
 *   would leave the file bar showing nothing for up to a whole cycle. `runProgressFromNames`
 *   (`runFolder.ts`) tells the two apart from the same listing, so an in-progress first sighting
 *   is pulled immediately instead of waited out.
 * - **Nothing is stored about "in progress".** The assembled archive carries the `begun` marker
 *   and not `ended`, which is the whole of how the rest of the app knows (see `runFolder.ts`).
 *   Reload the page mid-run and the file still reads as in-progress, because the fact lives in
 *   the file.
 *
 * The one command this issues that *changes* the instrument is the §7.6 acknowledgement — see
 * `finish` below for why it is both safe and necessary.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  CFX_CURRENT_RUN_DIR,
  USB_TRAFFIC_LOG_NAME,
  zpcrFromRunFiles,
  zpcrNameFromRunFiles,
  runFilesToFetch,
  runIdentityFileNames,
  isSameRun,
  runProgressFromNames,
  type ZpcrArchive,
} from "@zpcrweb/core";
import type { CfxDeviceHandle } from "./useCfxDevice";

/**
 * Files whose *content* changes while the run goes on, so the copy in the run's archive goes stale
 * — re-read **only on the end-of-run pass**, never per cycle.
 *
 * Everything else in the folder is written once and never revised: the `.Dcal` set, the plate,
 * the protocol and `GlobData.xml` at the start, and each `Read0000N.Plateread` as its cycle ends
 * — a new read means a new *name*, which the archive doesn't have and so is fetched anyway. So a
 * cycle's download is exactly the 22 KB read that cycle produced.
 *
 * Two of these genuinely grow: `runlog.xml` accumulates an entry per event (31 KB by the end of a
 * 45-cycle run) and `lastplatereadstatus` is a 16-byte record whose payload is the completed-read
 * count. Re-pulling those every cycle was ~40 KB per cycle on top of the 22 KB read — over a
 * 64-byte bulk endpoint, and behind `useCfxDevice`'s `busy` flag, which stalls the status poll for
 * the duration — to refresh two things nothing consumes until the run is over. Only the final
 * archive needs them complete, so that is the only pass that re-reads them, and a run in progress
 * carries the copy it first saw (visible in the Raw view's run log, which is that far behind
 * mid-run and correct once the run ends).
 *
 * `RunInfo.xml` is here for a different reason: it isn't rewritten during a run, but it is
 * *deposited* by this app after the run starts (`usb.md` §7.4) and survives in the folder from the
 * previous run until it is, so the one re-read at the end costs 8 KB once and removes any question
 * of a run's file holding the previous run's metadata.
 *
 * `ProtocolName.txt` is deliberately **not** here. It only appears at the finish, so an archive
 * without it fetches it on that pass regardless — and listing it would re-read it over a protocol
 * name the user had edited during the run.
 */
const REFETCH_AT_END = new Set(["runinfo.xml", "runlog.xml", "lastplatereadstatus"]);

/** Identity of a listing, for "has anything changed?" — order-independent. */
function signatureOf(names: readonly string[]): string {
  return [...names].sort().join(" ");
}

/** True when `STATUS?`'s step text is a plate read (`usb.md` §7.5's live echo of §3.1). */
function isPlateRead(stepText: string | undefined): boolean {
  return !!stepText && /^PLATEREAD\b/i.test(stepText.trim());
}

export interface RunWatchState {
  /** True while the watcher is polling — connected, and following enabled. */
  watching: boolean;
  setWatching: (on: boolean) => void;
  /** What the watcher last did, for the rail to show. */
  note: string | null;
  /** The id of the file the watcher most recently put in the store, if it is still there. */
  fileName: string | null;
  /**
   * Take over a file this watcher didn't produce: the seed `.zpcr` written at the click on Start
   * run (`core/runSeed.ts`), which is the first version of the very run about to be followed.
   *
   * Without this the watcher's first pull would report `previousId: null`, and the caller — which
   * uses that to decide whether the user was looking at the file being superseded — would leave
   * them on the seed while the real snapshots piled up beside it. Adopting it says "the run I am
   * about to follow is already on screen as this".
   */
  adopt: (fileName: string) => void;
  /**
   * Set once a run this session watched running has finished and its final `.zpcr` has been
   * assembled: what it was called, how long it ran, and the id of that final file — everything
   * the Instrument view's "Run complete" banner needs. Null the rest of the time, including while
   * the §7.6 acknowledgement above is still in flight (the banner is for a run that's actually
   * done, not merely idle-and-held).
   */
  finished: { name: string; totalS: number; fileName: string } | null;
  /** Dismiss the banner — the Instrument view's "New run" button. */
  clearFinished: () => void;
  /**
   * Say that the run about to be started will leave no run folder behind, so this watcher should
   * expect its `.alf` report and nothing else (`App`'s `startExperiment`, for a thermal-only
   * protocol — see `RunPlan.producesRunFile`).
   *
   * An optimisation of honesty rather than of bytes: {@link collectReport} is reached anyway when
   * the end-of-run listing turns out unchanged, so a thermal-only run started from the instrument's
   * own touchscreen gets the same treatment. Saying so in advance only skips the listing that would
   * discover it, and stops the run's last moments being spent fetching a folder we already know
   * isn't ours.
   */
  expectReportOnly: () => void;
  /**
   * A run sitting on the instrument that this browser **isn't holding** — what it is called and
   * how far it got. Null whenever the folder's run is already in the file bar, or holds no run at
   * all.
   *
   * This is the answer to "I connected after the run finished, where is it?". A finished run in
   * the folder is deliberately never pulled on sight (see the module comment: it is usually the
   * *previous* run, and a surprise 400 KB transfer plus an unrequested file is not what connecting
   * asks for) — but saying nothing about it left the only way in as the Files panel's "Open run",
   * behind a collapsed disclosure titled as a storage browser. So the fact is offered instead of
   * acted on: the rail says a run is there and unheld, and {@link downloadAvailable} is the click.
   *
   * Costs the same ~8 KB identity read a pass already does (`runIdentityFileNames`), once per
   * connection, and answers exactly — the run's own `RunInfo.xml` against the file's
   * (`isSameRun`), not a guess from the name.
   */
  available: { name: string; plateReads: number; inProgress: boolean } | null;
  /** Download the run {@link available} describes, whole, and put it in the file bar. */
  downloadAvailable: () => Promise<void>;
}

export function useRunWatch(
  instrument: CfxDeviceHandle,
  /**
   * Hand what the instrument has written to the app.
   *
   * **`archive` is what this pass wrote, not the whole run** — normally one plate read, and at the
   * end of a run the last read plus `ended`, the `.alf` report and the three `REFETCH_AT_END`
   * files. The store merges it into the file of this name (`addRunArchive`'s `merge`), so a run
   * being followed grows by exactly what arrived and everything else about the file is left alone.
   *
   * `whole: true` marks the one pass that *is* the whole folder — the first of the session, or the
   * first after the folder was cleared for a different run — where there is nothing to merge into
   * and the archive stands as the file's entire content.
   *
   * That split is what keeps a plate attached to a run in progress attached. Every pass used to
   * hand over the whole folder, which is the instrument's copy of the run and knows nothing of
   * anything the app added on top: the next plate read — or, most visibly, the end-of-run pass —
   * put the instrument's own plate back and dropped the one the user had swapped in. Handing over
   * only what the instrument actually wrote means an entry it never touched cannot be overwritten
   * by it, and `runFilesToFetch` makes sure the folder's plate isn't even fetched into a run that
   * already has one.
   *
   * `previousId` is the file this one supersedes, so the caller
   * can decide whether to follow the new copy (the user was looking at it) or leave the selection
   * alone (they were looking at something else). `activate` overrides that: select this file
   * whatever the user was looking at. It is true for the two files someone just *caused to exist*
   * and expects to be looking at —
   *
   * - a run that **began while this session was watching**, as opposed to one already going when
   *   the folder was first listed (a reconnect, or a page load mid-run). The two look identical in
   *   the listing itself, so only the live `running` false→true edge tells them apart.
   * - a run the user asked for by clicking **Download run** ({@link RunWatchState.available}).
   *
   * Returns the new file's id.
   */
  onRun: (
    run: { name: string; archive: ZpcrArchive; whole: boolean },
    previousId: string | null,
    activate: boolean,
  ) => Promise<string | null>,
  /**
   * Put a finished run's `.alf` report in the file bar, selected, and hand back its id.
   *
   * The counterpart to {@link onRun} for a run that produced no run folder — see
   * {@link RunWatchState.expectReportOnly}. Kept separate rather than folded into `onRun` because
   * the two hand over different things: `onRun` merges an archive into a run's own file, and this
   * adds a plain file of a different kind, through the same path a dropped file takes.
   */
  onReport: (name: string, bytes: Uint8Array) => Promise<string | null>,
  /**
   * Read back the entries of a run this app is holding, or `null` if it isn't holding that file.
   *
   * **This is the watcher's only memory of what it has downloaded.** The run's file is the app's
   * copy of the run, so keeping a second copy here — as this hook used to, a name→bytes map of the
   * whole folder — was the same ~400 KB stored twice, and the two could disagree: the file was
   * where the user's edits went and the map was what the next pass believed the instrument's
   * folder to be. Asking the file instead makes "what do we have?" a question with one answer.
   * Delete a run mid-way and the next pass sees an empty hand and fetches all of it again, run
   * finished or not; keep it and the pass fetches the one plate read that arrived.
   *
   * A run whose file is *released* rather than deleted (its bytes dropped from memory, its record
   * kept) reads as `null` too, and is downloaded again. That is a rare thing to do to a run you
   * are watching, and the alternative — reading it back out of IndexedDB — would make every pass
   * of the watcher wait on a disk read for the ordinary case where the file is right there.
   */
  heldRun: (fileName: string) => ZpcrArchive | null,
  /**
   * What the Instrument view's two name fields currently hold (`state/useRunNaming.ts`). Only the
   * archive's *name* depends on it, and only for a run this app started and is still staging —
   * `zpcrFromRunFiles` decides that from the `zpcrweb.json` in the folder, so a run started at
   * the touchscreen keeps the name the instrument gave it whatever is typed here.
   */
  naming?: { experimentName: string; fileName: string },
): RunWatchState {
  const [watching, setWatching] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [finished, setFinished] = useState<{ name: string; totalS: number; fileName: string } | null>(
    null,
  );
  const [available, setAvailable] = useState<RunWatchState["available"]>(null);

  // Whether this connection has established *which file* the run in the folder belongs to. Not a
  // copy of anything: the answer is a name, and the run itself lives only in that file. Cleared on
  // a disconnect and whenever the folder is cleared for a different run, both of which mean the
  // question has to be asked again (see `pull`).
  const identified = useRef(false);
  // The last listing seen, for "has anything changed?" and for "is this still the same run?".
  // Names only — it says what the instrument's folder holds, not what is in any of it.
  const lastNames = useRef<readonly string[] | null>(null);
  // Set on the `running` false→true edge below, and consumed by the next successful `pull()` —
  // that pull is the file it belongs to.
  const activateNext = useRef(false);
  // A run being pulled must not have a second pull started on top of it: the fetch is slow (many
  // sequential commands) and both the timer and the status watcher can ask at once.
  const pulling = useRef(false);
  // Set by the end-of-run pass when the folder turned out not to be this run's — see `check`.
  const staleAtFinish = useRef(false);
  // Armed by `expectReportOnly` when the run being started is known in advance to write no run
  // folder. Cleared as each run starts, so it never carries over to the next one.
  const reportOnly = useRef(false);
  // The callback changes identity on every App render; the effects below must not restart for
  // that, so they read the latest through refs.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const onReportRef = useRef(onReport);
  onReportRef.current = onReport;
  // Read through a ref for the same reason: it closes over the loaded files, so it changes
  // identity whenever any of them does — including on every pass this hook itself causes.
  const heldRunRef = useRef(heldRun);
  heldRunRef.current = heldRun;
  // Likewise read through a ref: a keystroke in the name field must not restart the poll.
  const namingRef = useRef(naming);
  namingRef.current = naming;
  const fileNameRef = useRef<string | null>(null);
  fileNameRef.current = fileName;

  const {
    connection,
    status,
    refreshRunFolder,
    fetchDirectoryFiles,
    acknowledgeFinishedRun,
    fetchRunReport,
    trafficLogForRun,
  } = instrument;

  /**
   * Is the run in the folder one this browser is holding? Sets {@link RunWatchState.available} to
   * what it would download if not.
   *
   * The same identity read a pass does, for the case where there will be no pass: a folder holding
   * a run that is over is left alone (see `check`), so without this the app would know a run is
   * there — the rail says `finished`, with a plate-read count — and never say whose it is or that
   * it could be had. Answering costs ~8 KB and one round trip, once per connection.
   */
  const checkAvailable = useCallback(
    async (names: string[]): Promise<void> => {
      const idNames = runIdentityFileNames(names);
      if (idNames.length === 0) {
        setAvailable(null); // not a run folder at all — nothing to offer
        return;
      }
      const files = await fetchDirectoryFiles(CFX_CURRENT_RUN_DIR, idNames);
      if (!files) return; // a failed read leaves the last answer standing; the rail reports it
      const progress = runProgressFromNames(names);
      const name = zpcrNameFromRunFiles(files, namingRef.current);
      setAvailable(
        isSameRun(heldRunRef.current(name), files)
          ? null
          : { name, plateReads: progress.plateReads, inProgress: progress.inProgress },
      );
    },
    [fetchDirectoryFiles],
  );

  /**
   * Fetch whatever this listing holds that the run's own file doesn't, and hand it over.
   *
   * `finalAssembly` marks the end-of-run pass (see `check`), and does two things: it re-reads the
   * `REFETCH_AT_END` files, whose copies in the file are as old as the moment they first arrived,
   * and
   * it adds the session's USB traffic log as an extra entry, when the console's "save log" switch
   * asks for one (`trafficLogForRun` decides; see `useCfxDevice.setSaveLog`). Both belong to this
   * pass only — every intermediate `.zpcr` a run produces stays exactly what's on the instrument,
   * and the log is a one-time addition once there's nothing left to supersede it. Reading the
   * switch *here*, at the end, is also what lets someone turn it on mid-run and still get the
   * whole run: the recording was running the entire time either way.
   */
  const pull = useCallback(
    async (names: string[], finalAssembly = false): Promise<string | null> => {
      // **What the run's file already holds is the record of what has been downloaded.** Every
      // pass reads it back rather than consulting anything kept here, so the answer is always the
      // truth about the file the user actually has: delete it and the next pass fetches the run
      // from the top, keep it and only what the instrument has newly written is fetched.
      let file = identified.current ? fileNameRef.current : null;
      let held = file ? heldRunRef.current(file) : null;
      let identity: ZpcrArchive = {};
      if (!held) {
        // We don't know which file this folder's run belongs to — a fresh connection, a folder the
        // instrument has cleared for a different run, or a file that has gone. Read the two
        // entries that *name* a run (~8 KB of ~400 KB) and let them point at it: the file they
        // name, if we hold that same run, and otherwise nothing, which is a full download.
        const idNames = runIdentityFileNames(names);
        if (idNames.length > 0) {
          const fetched = await fetchDirectoryFiles(CFX_CURRENT_RUN_DIR, idNames);
          if (!fetched) return null; // the fetch failed; the rail reports it, and we retry next tick
          identity = fetched;
          file = zpcrNameFromRunFiles(fetched, namingRef.current);
          const candidate = heldRunRef.current(file);
          // A file of the right name is not necessarily the right run: the instrument clears the
          // folder when a run starts, so `RunInfo.xml` has to agree before we append to it.
          held = isSameRun(candidate, fetched) ? candidate : null;
          identified.current = true;
        }
      }
      const wanted = runFilesToFetch(held, names, finalAssembly ? REFETCH_AT_END : undefined);
      const fetched: ZpcrArchive = {};
      const missing = wanted.filter((n) => identity[n] === undefined);
      if (missing.length > 0) {
        const got = await fetchDirectoryFiles(CFX_CURRENT_RUN_DIR, missing);
        if (!got) return null; // as above — a failed fetch is retried, not reported as a bad run
        Object.assign(fetched, got);
      }
      for (const name of wanted) {
        const already = identity[name];
        if (already) fetched[name] = already;
      }
      const files: ZpcrArchive = { ...held, ...fetched };
      if (finalAssembly) {
        const log = trafficLogForRun();
        if (log) {
          files[USB_TRAFFIC_LOG_NAME] = log;
          fetched[USB_TRAFFIC_LOG_NAME] = log;
        }
      }
      const activate = activateNext.current;
      activateNext.current = false;
      try {
        // Handed over as the archive it already is, not as zipped bytes: the store keeps a run in
        // progress open and appends to it (see its `addRunArchive` and `state/fileContent.ts`), so
        // a cycle costs the one plate read that arrived and no ZIP work at either end.
        //
        // The folder as a whole — what the file holds plus what this pass fetched — is what names
        // the run (`zpcrFromRunFiles`) and what proves it is one; what goes *to the store* is only
        // what this pass fetched, unless there is nothing there to lay it over.
        const run = zpcrFromRunFiles(files, namingRef.current);
        // A pass is whole when there is no file of ours to update: a run this browser doesn't
        // have, or one whose file has just been renamed out from under us — the name is re-derived
        // here from the folder's own `RunInfo.xml`, which the end-of-run pass re-reads, so it can
        // move mid-run. An update is only a run when laid over the rest of one; where that is
        // missing, everything we have goes over instead, including whatever the user had added to
        // the file it came from.
        const whole = held === null || run.name !== file;
        const update = whole ? files : fetched;
        const id = await onRunRef.current(
          { name: run.name, archive: update, whole },
          fileNameRef.current,
          activate,
        );
        setFileName(id);
        // Whatever was on offer is now in the file bar — this pass is what installed it.
        if (id) setAvailable(null);
        const reads = names.filter((n) => /\.Plateread$/i.test(n)).length;
        setNote(`Updated at ${new Date().toLocaleTimeString()} — ${reads} plate reads`);
        return id;
      } catch (e) {
        // An incomplete folder (no RunInfo.xml yet, in the seconds after a run starts) throws
        // here. That's a "not yet", not a failure — the next check will find it.
        setNote(e instanceof Error ? e.message : String(e));
        return null;
      }
    },
    [fetchDirectoryFiles, trafficLogForRun],
  );

  /**
   * List the run folder, and pull it if anything changed. `force` skips the change test, for the
   * end-of-run pass where the interesting files land in the same moment we look — that pass is
   * also the one that gets `finalAssembly`, embedding the USB traffic log (see `pull`).
   */
  const check = useCallback(
    async (force = false, finalAssembly = false): Promise<string | null> => {
      if (pulling.current) return null;
      pulling.current = true;
      try {
        const dir = await refreshRunFolder();
        if (!dir?.listed) return null;
        const previous = lastNames.current;
        const first = previous === null;
        const changed = previous === null || signatureOf(previous) !== signatureOf(dir.names);
        // A name that was there and has *gone* means the instrument cleared the folder for a
        // different run, so the file we have been writing to is not this run's. Asking again costs
        // one small read (`pull`'s identity fetch), and it is what stops a run started while we
        // watched — same folder, and possibly the same derived name — from being appended to the
        // previous run's file.
        if (previous) {
          const present = new Set(dir.names);
          if (previous.some((n) => !present.has(n))) identified.current = false;
        }
        lastNames.current = dir.names;
        // See the module comment: the folder usually holds the last run when we arrive, but not
        // always — a reload mid-run, or a connect that happens after the run had already started,
        // presents a first listing that is itself in progress. Don't make that wait for a change.
        if (first && !force) {
          if (runProgressFromNames(dir.names).inProgress) {
            setNote("Found a run already in progress — pulling its current state.");
            return await pull(dir.names);
          }
          setNote("Watching for changes to the current run.");
          // Not pulling it doesn't mean not mentioning it: if this is a run the app doesn't have,
          // that is worth saying, with a button (see `RunWatchState.available`).
          await checkAvailable(dir.names);
          return null;
        }
        // **The end-of-run pass is the one place a stale folder gets mistaken for a run.** It is
        // forced, so it would otherwise pull whatever is in `CurrentRun` whether or not this run
        // put it there — and a thermal-only run puts nothing there at all, leaving the *previous*
        // run's complete folder sitting where the pull would find it. That is how a 45-cycle qPCR
        // run once came back as the archive of a reverse-transcription incubation.
        //
        // A real run's finish always changes the listing: the last plate read, the `ended` marker
        // and the `.alf` all land in the moment §7.6's acknowledgement releases them. So an
        // unchanged listing here is proof the folder is not this run's, and the caller collects
        // the run's own report instead (see `staleAtFinish`).
        if (finalAssembly && !changed) {
          staleAtFinish.current = true;
          setNote("This run wrote no run folder — collecting its report instead.");
          return null;
        }
        staleAtFinish.current = false;
        if (changed || force) return await pull(dir.names, finalAssembly);
        return null;
      } finally {
        pulling.current = false;
      }
    },
    [refreshRunFolder, pull, checkAvailable],
  );

  /**
   * Fetch the finished run's `.alf` report and put it in the file bar, selected.
   *
   * What a thermal-only run produces instead of a `.zpcr` — the instrument writes one report per
   * run to `\Storage Card\PCRunReport` and clears that directory at the start of every run
   * (`usb.md` §7.1/§7.10), so the report waiting there afterwards is this run's. It is a real file
   * of the user's from that point on: an ordinary entry in the bar, in the catalog and in
   * IndexedDB, which they can read, keep or delete like any other.
   *
   * Selected on arrival for the same reason a run this session watched start is: it is the thing
   * that just came into existence because they pressed Start, and it is the only record that the
   * run happened at all.
   */
  const collectReport = useCallback(
    async (runName: string): Promise<string | null> => {
      const report = await fetchRunReport();
      if (!report) {
        setNote(`Run "${runName}" finished, and left no report on the instrument.`);
        return null;
      }
      const id = await onReportRef.current(report.name, report.bytes);
      setNote(
        id
          ? `Run "${runName}" finished — its report is in the file bar.`
          : `Run "${runName}" finished, but its report could not be opened.`,
      );
      return id;
    },
    [fetchRunReport],
  );

  /**
   * Download the run on offer, whole — the rail's button.
   *
   * A forced pass: it lists, and pulls whatever the identity read says we don't have, which for a
   * run this browser has never seen is all of it. `identified` is cleared first so the pass
   * re-derives which file the folder's run belongs to rather than trusting an answer from before
   * the user asked.
   */
  const downloadAvailable = useCallback(async () => {
    identified.current = false;
    // Asked for, so it is what the user wants to be looking at when it lands — the same override
    // a run starting during this session gets (see `onRun`'s `activate`).
    activateNext.current = true;
    setNote("Downloading the run on the instrument…");
    await check(true);
  }, [check]);

  // --- the step-transition rule (§7.5) -------------------------------------------------------
  const lastStep = useRef<string | null>(null);
  useEffect(() => {
    if (connection !== "connected" || !watching) return;
    const previous = lastStep.current;
    const current = status?.stepText ?? null;
    lastStep.current = current;
    // The completed file appears as the plate read *ends*, so this fires on the way out of one.
    if (isPlateRead(previous ?? undefined) && previous !== current) void check();
  }, [connection, watching, status?.stepText, check]);

  // --- the finished run (§7.6) ---------------------------------------------------------------
  //
  // A completed protocol leaves `STATUS?` reporting IDLE with the run's name still attached: the
  // instrument is *holding* the finished run. Acknowledging it is what releases that and makes
  // the final plate read, the `ended` marker and the `.alf` report appear — so without this the
  // run would sit in the file bar permanently flagged in-progress, missing its last cycle.
  //
  // `acknowledgeFinishedRun` re-checks the status itself before sending anything, because the
  // same command aborts a run that is still going. Guarded twice more here: once so a re-render
  // can't send it twice for one run, and once so this only ever applies to a run **this session
  // watched running**.
  //
  // That second guard is what stops it firing on connect. An instrument left holding a run that
  // finished yesterday presents exactly the same status, and acknowledging that one would both
  // send an unasked-for command and drag a 400 KB archive nobody requested into the file bar —
  // the same reason a first listing that turns out to be that stale finished run is never pulled.
  //
  // "This session watched it running" is remembered **by name, for the whole page session**, and
  // deliberately survives a disconnect. A run that finishes while the cable is out comes back as
  // exactly the status this acknowledges — IDLE, still holding the run — and a latch reset on
  // disconnect would take the reconnected session for a stranger and leave the run held forever:
  // no final plate read, no `ended` marker, no `.alf`, and a file stuck reading as in progress
  // with nothing in the app able to release it. Keyed by name rather than a boolean so the
  // reconnected session still refuses a *different* run it never saw cycling. A page reload is
  // still a stranger by design — memory is all there is to go on, and a reload has none.
  const acknowledged = useRef<string | null>(null);
  const watchedRuns = useRef<Set<string>>(new Set());
  // Tracks `status.running` purely to catch its false→true edge — see the module comment and
  // `onRun`'s `activate`. Distinct from `watchedRuns`, which remembers every run seen cycling
  // for the rest of the session (`acknowledgeFinishedRun` below needs that); this one un-latches
  // so the next start is caught too.
  const wasRunning = useRef(false);
  // The instrument's own elapsed-time counter (`CfxStatus.elapsedS`), captured while it's still
  // running: once `status.running` goes false the field itself is no longer meaningful (it's
  // reset for the next run), so this is the only place a completed run's total time can be read
  // from. Held across the whole run, not just its last poll, purely so the "Run complete" banner
  // below has a number to show — and across a disconnect too, where it is the last time seen
  // before the cable went rather than the true total. Under-reporting the duration of a run
  // nobody was watching the end of beats showing zero for it.
  const lastElapsed = useRef<number | null>(null);
  useEffect(() => {
    if (connection !== "connected" || !watching || !status) return;
    if (status.running || !status.runName) {
      // A new run clears the latch, so the next finish is acknowledged too. No listing here: the
      // step-transition rule's first plate read (or the baseline-on-connect pull, for a run found
      // already going) is what actually surfaces it — see the module comment.
      if (status.running) {
        acknowledged.current = null;
        if (status.runName) watchedRuns.current.add(status.runName);
        if (!wasRunning.current) {
          activateNext.current = true;
          setFinished(null); // a new run starting retires the previous one's banner
        }
        wasRunning.current = true;
        lastElapsed.current = status.elapsedS;
      } else {
        wasRunning.current = false;
      }
      return;
    }
    wasRunning.current = false;
    if (!watchedRuns.current.has(status.runName)) return;
    if (acknowledged.current === status.runName) return;
    acknowledged.current = status.runName;
    const finishedName = status.runName;
    const totalS = lastElapsed.current;
    // Consumed here: it described *this* run, and the next one gets to say for itself.
    const expectReport = reportOnly.current;
    reportOnly.current = false;
    void (async () => {
      setNote(
        expectReport
          ? `Run "${finishedName}" finished — collecting its report.`
          : `Run "${finishedName}" finished — collecting the last read.`,
      );
      // Sent either way: the acknowledgement is what releases the instrument from holding the
      // finished run, and a thermal-only run is held exactly as a qPCR one is.
      await acknowledgeFinishedRun();
      // Forced: the final read and `ended` land as part of this same moment, and waiting for the
      // signature to differ would just add a round trip. This is also the run's last `.zpcr`, so
      // the USB traffic log is attached here, if "save log" asks for one (see `finalAssembly`).
      //
      // Skipped outright when the run was known in advance to write no folder — there is nothing
      // to list for. Otherwise the listing itself answers it: `check` declines a stale folder and
      // says so through `staleAtFinish`, which is what catches a thermal-only run started at the
      // instrument's own touchscreen.
      const id = expectReport ? null : await check(true, true);
      if (id) {
        setFinished({ name: finishedName, totalS: totalS ?? 0, fileName: id });
        return;
      }
      if (!expectReport && !staleAtFinish.current) return; // a failed pass, retried by the next edge
      const reportId = await collectReport(finishedName);
      if (reportId) setFinished({ name: finishedName, totalS: totalS ?? 0, fileName: reportId });
    })();
  }, [connection, watching, status, acknowledgeFinishedRun, check, collectReport]);

  // --- the baseline listing on connect --------------------------------------------------------
  //
  // `check`'s `first` case pulls immediately if the folder is already mid-run, and otherwise just
  // records what it holds as a baseline to diff later listings against. Either way it takes one
  // listing, so it happens once here rather than waiting on whichever of the edges above happens
  // to fire first.
  useEffect(() => {
    if (connection !== "connected" || !watching) return;
    void check();
  }, [connection, watching, check]);

  // A disconnect ends the *listing's* identity here: the next connection re-establishes a baseline
  // rather than diffing against a folder it hasn't looked at in the meantime, and asks again which
  // file the folder's run belongs to rather than trusting an answer from before the cable went —
  // a whole different run may have been started and finished in the meantime.
  //
  // What it deliberately does not end is what this session knows about the run itself:
  // `watchedRuns` and `acknowledged` are page-session facts, not connection facts (see the §7.6
  // block above). Reconnecting to a run that finished in the meantime then takes the ordinary
  // path — the first listing sees a folder still in progress and pulls it, and the finished-run
  // effect acknowledges it, collecting the last read exactly as it would have live.
  useEffect(() => {
    if (connection === "connected") return;
    lastNames.current = null;
    lastStep.current = null;
    wasRunning.current = false;
    activateNext.current = false;
    identified.current = false;
    // The offer belongs to a connection: it describes what is in the instrument's folder right
    // now, and with the cable out there is nothing to download it from.
    setAvailable(null);
  }, [connection]);

  // The seed is this run's first file, so the watcher treats it exactly as one of its own
  // snapshots from here on (see `RunWatchState.adopt`).
  // Adopting a seed is the opposite claim to `expectReportOnly`'s — this run *has* a file — so it
  // also disarms it, which is what keeps a thermal-only start that never ran (cancelled, or the
  // send failed) from being remembered against the next run.
  const adopt = useCallback((id: string) => {
    reportOnly.current = false;
    setFileName(id);
  }, []);
  const clearFinished = useCallback(() => setFinished(null), []);
  const expectReportOnly = useCallback(() => {
    reportOnly.current = true;
    // Nothing of this run will land in a file of ours, so the watcher stops speaking for whatever
    // file it was last following — otherwise the previous run's id would be reported as this run's
    // when it ends.
    setFileName(null);
    setFinished(null);
  }, []);

  return {
    watching,
    setWatching,
    note,
    fileName,
    adopt,
    finished,
    clearFinished,
    expectReportOnly,
    available,
    downloadAvailable,
  };
}
