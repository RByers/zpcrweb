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
 * eventually produces be selected unconditionally (see `onRun`'s `freshStart` below).
 *
 * When a listing turns out to differ from the last one, the folder is pulled and handed to the
 * store as the `.zpcr` archive it is, which replaces the previous snapshot under the same name.
 * Nothing is zipped on the way: a run still going is kept open and appended to, and only the
 * end-of-run snapshot becomes an ordinary `.zpcr` file (see `state/fileContent.ts`). What that name is comes from
 * `runFolder.ts`: the file name typed in the Instrument view for a run this app started, and
 * otherwise whatever the run itself says it is called.
 *
 * Three things make that affordable enough to do every cycle:
 *
 * - **Only new files are fetched.** A `CurrentRun` is ~40 files, 28 of which are the `.Dcal`
 *   calibration set that never changes during a run; re-pulling those every cycle would put
 *   megabytes over a 64-byte-packet bulk endpoint for nothing. Bytes are cached by name, and a
 *   name already held is never fetched again — a file the instrument has written is final, and a
 *   new plate read arrives under a new name. A cycle's update is then exactly one 22 KB plate
 *   read. The four files that *are* rewritten as the run goes (`REFETCH_AT_END`) are re-read once,
 *   on the end-of-run pass, where the archive has to be complete.
 * - **The first listing is never downloaded — unless it's already running.** `CurrentRun` usually
 *   holds the *previous* run when you connect, finished and complete with its `ended` marker.
 *   Pulling that unasked would be a surprise 400 KB transfer and an unrequested file in the bar,
 *   so the first sighting ordinarily only records the signature to compare later ones against.
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
  runProgressFromNames,
  type ZpcrArchive,
} from "@zpcrweb/core";
import type { CfxDeviceHandle } from "./useCfxDevice";

/**
 * Files whose *content* changes while the run goes on, so a cached copy goes stale — re-fetched
 * **only on the end-of-run pass**, never per cycle.
 *
 * Everything else in the folder is written once and never revised: the `.Dcal` set, the plate,
 * the protocol and `GlobData.xml` at the start, and each `Read0000N.Plateread` as its cycle ends
 * — a new read means a new *name*, which the cache misses and fetches anyway. So a cycle's
 * download is exactly the 22 KB read that cycle produced.
 *
 * These four are the exceptions, and only two of them genuinely grow: `runlog.xml` accumulates an
 * entry per event (31 KB by the end of a 45-cycle run) and `lastplatereadstatus` is a 16-byte
 * record whose payload is the completed-read count. Re-pulling those every cycle was ~40 KB per
 * cycle on top of the 22 KB read — over a 64-byte bulk endpoint, and behind `useCfxDevice`'s
 * `busy` flag, which stalls the status poll for the duration — to refresh two things nothing
 * consumes until the run is over. Only the final archive needs them complete, so that is the only
 * pass that re-reads them, and an intermediate in-progress snapshot carries the copy it first saw
 * (visible in the Raw view's run log, which is that far behind mid-run and correct once the run
 * ends).
 *
 * `RunInfo.xml` and `ProtocolName.txt` are here for a different reason: neither is rewritten
 * during a run, but `RunInfo.xml` is *deposited* by this app after the run starts (`usb.md` §7.4)
 * and survives in the folder from the previous run until it is, so the one re-read at the end
 * costs 8 KB once and removes any question of a snapshot holding the previous run's metadata.
 * `ProtocolName.txt` only appears at the finish anyway, so the cache misses it there regardless.
 */
const REFETCH_AT_END = new Set([
  "runinfo.xml",
  "runlog.xml",
  "lastplatereadstatus",
  "protocolname.txt",
]);

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
}

export function useRunWatch(
  instrument: CfxDeviceHandle,
  /**
   * Hand an assembled run to the app. `previousId` is the file this one supersedes, so the caller
   * can decide whether to follow the new copy (the user was looking at it) or leave the selection
   * alone (they were looking at something else). `freshStart` is true when this file is the
   * result of a run that began while this session was watching — the `running` false→true edge
   * below — as opposed to one already going when the folder was first listed (a reconnect, or a
   * page load mid-run); the two look identical in the listing itself, so only that live edge
   * tells them apart, and it's what the caller uses to decide whether to select the new file
   * unconditionally. Returns the new file's id.
   */
  onRun: (
    run: { name: string; archive: ZpcrArchive },
    previousId: string | null,
    freshStart: boolean,
  ) => Promise<string | null>,
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

  const cache = useRef<Map<string, Uint8Array>>(new Map());
  const signature = useRef<string | null>(null);
  // Set on the `running` false→true edge below, and consumed by the next successful `pull()` —
  // that pull is the file this fresh start produced.
  const freshStart = useRef(false);
  // A run being pulled must not have a second pull started on top of it: the fetch is slow (many
  // sequential commands) and both the timer and the status watcher can ask at once.
  const pulling = useRef(false);
  // The callback changes identity on every App render; the effects below must not restart for
  // that, so they read the latest through refs.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  // Likewise read through a ref: a keystroke in the name field must not restart the poll.
  const namingRef = useRef(naming);
  namingRef.current = naming;
  const fileNameRef = useRef<string | null>(null);
  fileNameRef.current = fileName;

  const { connection, status, refreshRunFolder, fetchDirectoryFiles, acknowledgeFinishedRun, trafficLogForRun } =
    instrument;

  /**
   * Pull whatever this listing holds that we don't already have, and rebuild the `.zpcr`.
   *
   * `finalAssembly` marks the end-of-run pass (see `check`), and does two things: it re-reads the
   * `REFETCH_AT_END` files, whose cached copies are as old as the moment they were first seen, and
   * it adds the session's USB traffic log as an extra entry, when the console's "save log" switch
   * asks for one (`trafficLogForRun` decides; see `useCfxDevice.setSaveLog`). Both belong to this
   * pass only — every intermediate `.zpcr` a run produces stays exactly what's on the instrument,
   * and the log is a one-time addition once there's nothing left to supersede it. Reading the
   * switch *here*, at the end, is also what lets someone turn it on mid-run and still get the
   * whole run: the recording was running the entire time either way.
   */
  const pull = useCallback(
    async (names: string[], finalAssembly = false): Promise<string | null> => {
      // A name that has *gone* means this is a different run — the instrument clears the folder
      // when one starts — so held bytes may belong to the previous one.
      const present = new Set(names);
      for (const held of [...cache.current.keys()]) {
        if (!present.has(held)) {
          cache.current.clear();
          break;
        }
      }
      const wanted = names.filter(
        (n) => !cache.current.has(n) || (finalAssembly && REFETCH_AT_END.has(n.toLowerCase())),
      );
      if (wanted.length > 0) {
        const fetched = await fetchDirectoryFiles(CFX_CURRENT_RUN_DIR, wanted);
        if (!fetched) return null; // the fetch failed; the rail reports it, and we retry next tick
        for (const [name, bytes] of Object.entries(fetched)) cache.current.set(name, bytes);
      }
      const files = Object.fromEntries(cache.current);
      if (finalAssembly) {
        const log = trafficLogForRun();
        if (log) files[USB_TRAFFIC_LOG_NAME] = log;
      }
      const fresh = freshStart.current;
      freshStart.current = false;
      try {
        // Handed over as the archive it already is, not as zipped bytes: the store keeps a run in
        // progress open and appends to it (see its `addRunArchive` and `state/fileContent.ts`), so
        // a cycle costs the one plate read that arrived and no ZIP work at either end.
        const run = zpcrFromRunFiles(files, namingRef.current);
        const id = await onRunRef.current(run, fileNameRef.current, fresh);
        setFileName(id);
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
        const sig = signatureOf(dir.names);
        const first = signature.current === null;
        const changed = sig !== signature.current;
        signature.current = sig;
        // See the module comment: the folder usually holds the last run when we arrive, but not
        // always — a reload mid-run, or a connect that happens after the run had already started,
        // presents a first listing that is itself in progress. Don't make that wait for a change.
        if (first && !force) {
          if (runProgressFromNames(dir.names).inProgress) {
            setNote("Found a run already in progress — pulling its current state.");
            return await pull(dir.names);
          }
          setNote("Watching for changes to the current run.");
          return null;
        }
        if (changed || force) return await pull(dir.names, finalAssembly);
        return null;
      } finally {
        pulling.current = false;
      }
    },
    [refreshRunFolder, pull],
  );

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
  const acknowledged = useRef<string | null>(null);
  const sawRunning = useRef(false);
  // Tracks `status.running` purely to catch its false→true edge — see the module comment and
  // `onRun`'s `freshStart`. Distinct from `sawRunning`, which latches true for the rest of the
  // session (`acknowledgeFinishedRun` below needs that); this one un-latches so the next start
  // is caught too.
  const wasRunning = useRef(false);
  // The instrument's own elapsed-time counter (`CfxStatus.elapsedS`), captured while it's still
  // running: once `status.running` goes false the field itself is no longer meaningful (it's
  // reset for the next run), so this is the only place a completed run's total time can be read
  // from. Held across the whole run, not just its last poll, purely so the "Run complete" banner
  // below has a number to show.
  const lastElapsed = useRef<number | null>(null);
  useEffect(() => {
    if (connection !== "connected" || !watching || !status) return;
    if (status.running || !status.runName) {
      // A new run clears the latch, so the next finish is acknowledged too. No listing here: the
      // step-transition rule's first plate read (or the baseline-on-connect pull, for a run found
      // already going) is what actually surfaces it — see the module comment.
      if (status.running) {
        acknowledged.current = null;
        sawRunning.current = true;
        if (!wasRunning.current) {
          freshStart.current = true;
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
    if (!sawRunning.current) return;
    if (acknowledged.current === status.runName) return;
    acknowledged.current = status.runName;
    const finishedName = status.runName;
    const totalS = lastElapsed.current;
    void (async () => {
      setNote(`Run "${finishedName}" finished — collecting the last read.`);
      await acknowledgeFinishedRun();
      // Forced: the final read and `ended` land as part of this same moment, and waiting for the
      // signature to differ would just add a round trip. This is also the run's last `.zpcr`, so
      // the USB traffic log is attached here, if "save log" asks for one (see `finalAssembly`).
      const id = await check(true, true);
      if (id) setFinished({ name: finishedName, totalS: totalS ?? 0, fileName: id });
    })();
  }, [connection, watching, status, acknowledgeFinishedRun, check]);

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

  // A disconnect ends the run's identity here: the next connection re-establishes a baseline
  // rather than diffing against a folder it hasn't looked at in the meantime.
  useEffect(() => {
    if (connection === "connected") return;
    signature.current = null;
    lastStep.current = null;
    acknowledged.current = null;
    sawRunning.current = false;
    wasRunning.current = false;
    freshStart.current = false;
    cache.current.clear();
  }, [connection]);

  // The seed is this run's first file, so the watcher treats it exactly as one of its own
  // snapshots from here on (see `RunWatchState.adopt`).
  const adopt = useCallback((id: string) => setFileName(id), []);
  const clearFinished = useCallback(() => setFinished(null), []);

  return { watching, setWatching, note, fileName, adopt, finished, clearFinished };
}
