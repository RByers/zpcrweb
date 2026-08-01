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
 * rule work at all, and one more on the `running` false→true edge: `STATUS?`'s `running` flag says
 * a run has started live, without a listing, but the "Current run" panel's own state comes from
 * `runProgressFromNames` on the *last listing*, not from `status` directly — so without this edge
 * it would keep showing the previous run's `finished`/`no run` state until the new run's first
 * plate read completes.
 *
 * When a listing turns out to differ from the last one, the folder is pulled and zipped into a
 * `.zpcr` exactly as the Instrument view's **Open run** button does, and handed to the store,
 * which replaces the previous snapshot under the same name.
 *
 * Three things make that affordable enough to do every cycle:
 *
 * - **Only new files are fetched.** A `CurrentRun` is ~40 files, 28 of which are the `.Dcal`
 *   calibration set that never changes during a run; re-pulling those every cycle would put
 *   megabytes over a 64-byte-packet bulk endpoint for nothing. Bytes are cached by name, and only
 *   names not already held — plus the handful that genuinely change — are fetched. A cycle's
 *   update is then one 22 KB plate read and a small XML.
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
import { CFX_CURRENT_RUN_DIR, runProgressFromNames, zpcrFromRunFiles } from "@zpcrweb/core";
import type { CfxDeviceHandle } from "./useCfxDevice";

/**
 * Files whose *content* changes while the run goes on, so a cached copy goes stale.
 *
 * Everything else in the folder is either written once at the start (the `.Dcal` set, the plate
 * and protocol, `GlobData.xml`) or is a zero-length marker whose name is the entire message.
 * `Read0000N.Plateread` is not here on purpose: each is written once and never revised — a new
 * cycle means a new *name*, which the cache misses and fetches anyway.
 */
const VOLATILE = new Set(["runinfo.xml", "runlog.xml", "lastplatereadstatus", "protocolname.txt"]);

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
  fileId: string | null;
}

export function useRunWatch(
  instrument: CfxDeviceHandle,
  /**
   * Hand an assembled run to the app. `previousId` is the file this one supersedes, so the caller
   * can decide whether to follow the new copy (the user was looking at it) or leave the selection
   * alone (they were looking at something else). Returns the new file's id.
   */
  onRun: (file: File, previousId: string | null) => Promise<string | null>,
): RunWatchState {
  const [watching, setWatching] = useState(true);
  const [note, setNote] = useState<string | null>(null);
  const [fileId, setFileId] = useState<string | null>(null);

  const cache = useRef<Map<string, Uint8Array>>(new Map());
  const signature = useRef<string | null>(null);
  // A run being pulled must not have a second pull started on top of it: the fetch is slow (many
  // sequential commands) and both the timer and the status watcher can ask at once.
  const pulling = useRef(false);
  // The callback changes identity on every App render; the effects below must not restart for
  // that, so they read the latest through refs.
  const onRunRef = useRef(onRun);
  onRunRef.current = onRun;
  const fileIdRef = useRef<string | null>(null);
  fileIdRef.current = fileId;

  const { connection, status, refreshRunFolder, fetchDirectoryFiles, acknowledgeFinishedRun } =
    instrument;

  /** Pull whatever this listing holds that we don't already have, and rebuild the `.zpcr`. */
  const pull = useCallback(
    async (names: string[]) => {
      // A name that has *gone* means this is a different run — the instrument clears the folder
      // when one starts — so held bytes may belong to the previous one.
      const present = new Set(names);
      for (const held of [...cache.current.keys()]) {
        if (!present.has(held)) {
          cache.current.clear();
          break;
        }
      }
      const wanted = names.filter((n) => !cache.current.has(n) || VOLATILE.has(n.toLowerCase()));
      if (wanted.length > 0) {
        const fetched = await fetchDirectoryFiles(CFX_CURRENT_RUN_DIR, wanted);
        if (!fetched) return; // the fetch failed; the rail reports it, and we retry next tick
        for (const [name, bytes] of Object.entries(fetched)) cache.current.set(name, bytes);
      }
      const files = Object.fromEntries(cache.current);
      try {
        const { name, bytes } = zpcrFromRunFiles(files);
        const id = await onRunRef.current(new File([bytes.slice()], name), fileIdRef.current);
        setFileId(id);
        const reads = names.filter((n) => /\.Plateread$/i.test(n)).length;
        setNote(`Updated at ${new Date().toLocaleTimeString()} — ${reads} plate reads`);
      } catch (e) {
        // An incomplete folder (no RunInfo.xml yet, in the seconds after a run starts) throws
        // here. That's a "not yet", not a failure — the next check will find it.
        setNote(e instanceof Error ? e.message : String(e));
      }
    },
    [fetchDirectoryFiles],
  );

  /**
   * List the run folder, and pull it if anything changed. `force` skips the change test, for the
   * end-of-run pass where the interesting files land in the same moment we look.
   */
  const check = useCallback(
    async (force = false) => {
      if (pulling.current) return;
      pulling.current = true;
      try {
        const dir = await refreshRunFolder();
        if (!dir?.listed) return;
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
            await pull(dir.names);
          } else {
            setNote("Watching for changes to the current run.");
          }
          return;
        }
        if (changed || force) await pull(dir.names);
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
  const runIsActive = useRef(false);
  useEffect(() => {
    if (connection !== "connected" || !watching || !status) return;
    if (status.running) {
      // A new run clears the latch, so the next finish is acknowledged too, and — on the
      // false→true edge — lists once so the "Current run" panel doesn't keep showing the
      // previous run's terminal state until the first plate read comes in.
      acknowledged.current = null;
      sawRunning.current = true;
      if (!runIsActive.current) {
        runIsActive.current = true;
        void check();
      }
      return;
    }
    runIsActive.current = false;
    if (!status.runName) return;
    if (!sawRunning.current) return;
    if (acknowledged.current === status.runName) return;
    acknowledged.current = status.runName;
    void (async () => {
      setNote(`Run "${status.runName}" finished — collecting the last read.`);
      await acknowledgeFinishedRun();
      // Forced: the final read and `ended` land as part of this same moment, and waiting for the
      // signature to differ would just add a round trip.
      await check(true);
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
    runIsActive.current = false;
    cache.current.clear();
  }, [connection]);

  return { watching, setWatching, note, fileId };
}
